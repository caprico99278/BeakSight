# R14 指示書: Task 14（ページ監査）のチェックポイントの独立レビュー

あなたは、BeakSight リポジトリ（`C:\Develop\github-repo\BeakSight`）の独立レビュー担当です。BeakSight は、Node.js 24、TypeScript strict、Playwright Library、Vitest で作られた CLI です。

このレビューは、実装タスク指示 第12章のチェックポイント（Task 14）です。Critical と Important がなければ、Task 14 を完了とします。

## 厳守事項

- ファイルを一切、編集も作成もしないでください（読み取り専用）。
  - 検証用のスクリプトが必要な場合は、リポジトリの外（一時ディレクトリ）に置いてください。
- Git は、表示だけのコマンドを使ってください。使ってよいのは、`git status`、`git diff`、`git log`、`git show`、`git blame` です。
  - commit、push、checkout、restore、reset、stash、switch、worktree は禁止です。
- `npm run build` は実行しないでください。
  - テストは、`npx vitest run <対象ファイル>` のように、対象を絞って実行してください。
  - `npm run typecheck` は、実行してかまいません。
- `npx` は、`node_modules` に導入済みのコマンドだけに使ってください。
- インターネット上のサイトにアクセスしないでください。とくに 本来の監査対象のサイトへのアクセスは禁止です。
  - `local/` 配下のファイルは使わないでください。
  - 検証は、ローカルの fixture と `127.0.0.1` のサーバだけで行ってください。

## 対象

- 設計書:
  - `doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md` の第3章と第4章（とくに 4.3.0 と 4.5）
  - `doc/design/2026-09-24-beaksight-task-14-implementation-plan.md`
- 上位の文書:
  - `doc/design/2026-08-27-beaksight-implementation-tasks.md`（SSOT Owner Matrix、Safety Invariants、禁止事項、第12章）
  - `doc/design/2026-08-27-beaksight-implementation-plan.md` の Task 14
  - `doc/design/2026-08-27-beaksight-web-audit-design.md`
- 関連する設計書:
  - `doc/design/2026-09-23-beaksight-task-12-13-rules-design.md`（Safety の Evidence 5.4.1、Cross-page rule の入力 第7章）
  - `doc/design/2026-09-23-beaksight-foundation-corrections-design.md`（Interaction 4.4、Guard）
- 共通部品台帳: `doc/design/beaksight-shared-components.md`
- 実装:
  - `src/orchestration/` の下のすべてのファイル（page-auditor、id-allocator、page-navigation、stress-session、evidence-builder、stage-deadline）
  - P14a で変更したファイル: `src/core/contracts.ts`、`evidence-types.ts`、`limits.ts`、`status.ts`、`src/config/validate-config.ts`、`schemas/*.json`、`src/safety/safety-ledger.ts`
- 報告: 作業記録置き場（`.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`）の次のファイル
  - `P14a-report.md`、`P14b-report.md`、`P14c-report.md`、`P14d-report.md`
  - 報告の末尾の「設計者の判断」は、設計者が承認した事項です。

## とくに確かめること

1. **安全の不変条件**
   - Passive Context で、GET と HEAD 以外が送られないこと。
   - Interaction は、隔離された Context だけで行われること。
   - 機械的に除外される候補も、すべて `auditInteraction` に渡され、Safety Ledger に記録されること。
   - Context が、どの失敗の経路でも閉じられること。
   - 閉じる処理の失敗が、隠されないこと。
   - 実際の Chromium で、fixture を使って確かめてください。
2. **完了の正直さ**
   - 必須の段階が COMPLETE でない場合、Rule の失敗がある場合、予算が足りない場合、後片付けに失敗した場合に、`AUDITED` にならないこと。
   - ビューポートの状態が、ページの集計で隠れないこと。
   - `SKIPPED` の扱いが正しいこと。
   - ナビゲーションの失敗が、正しい `navigationOutcome` と `NAVIGATION_FAILED` で記録されること。
   - ナビゲーションが失敗した場合も、network の Evidence が記録されること。
3. **処理の順序と Evidence**
   - 設計書 4.5.2 の順序で処理されること。とくに、Interaction の Safety の Evidence が、Rule の入力に含まれること。
   - Finding が、実在し、同じビューポートの Evidence だけを参照すること。
   - ID が Run の中で一意で、決定論的であること。
   - Link が `link` の Evidence として1回だけ記録されること（ARCH03）。
   - 幅の走査が、Desktop で1回だけ行われ、主要な幅が除かれること。
4. **期限と予算**
   - 各段階の期限の計算が、1か所で行われること。
   - Interaction の候補ごとの期限が、設計書 4.5.7 のとおりであること。
   - 読み込みの遅いページや、多くの候補があるページで、ページの監査が期限を大きく超えないこと。
   - どこかで止まり続ける経路がないこと。例: crash した page、閉じない Context。
5. **SSOT と共通化**
   - 次の処理が、共通部品台帳の部品だけで行われること。
     - 状態の集計
     - 理由の書式
     - ID の採番
     - URL の正規化
     - Safety の集計
     - 凍結
   - Rule の登録、Run Status の判定、スキーマの検証の owner に、第二の owner がないこと。
   - `src/**` に、対象のサイトに固有の情報がないこと。
6. **型とスキーマ**
   - 実際の結果が、`page` のスキーマに合うこと。
   - enum が core の配列と一致すること。
7. **テストの質**
   - 統合テストが、実装の誤りを検出できる形になっていること。
   - テストの後に、Context やブラウザのプロセスが残らないこと。
   - 実行時間が妥当であること。

## 報告

意味の通る日本語で、次の形式で返してください。全体で3000字程度までとし、重要度の高いものを優先してください。

- 総合判定: 承認 / 修正が必要
- 指摘: 各指摘に、次のことを書いてください。
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

設計者が報告の中で承認した事項は、それ自体を指摘しなくてかまいません。ただし、その判断が仕様に反すると考える場合は、根拠とともに指摘してください。推測だけの指摘は、「推測」と明記してください。
