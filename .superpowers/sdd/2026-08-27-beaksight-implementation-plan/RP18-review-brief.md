# RP18 指示書: Task 18 の前の整理（DEF-008 ほか）の、Guard の独立レビュー

あなたは、BeakSight リポジトリ（`C:\Develop\github-repo\BeakSight`）の独立レビュー担当です。BeakSight は、Node.js 24、TypeScript strict、Playwright Library、Vitest の、読み取り専用の Web サイト監査 CLI です。

このレビューは、Task 18（Safety / Auditor Acceptance Gates）に進む前の、安全の境界のレビューです。Critical と Important がなければ、Task 18 に進みます。

## 厳守事項

- ファイルを一切、編集も作成もしないでください（読み取り専用）。
  - 検証用のスクリプトや出力は、リポジトリの外（一時ディレクトリ）に置いてください。
  - 一時ディレクトリに、リポジトリへのリンク（ジャンクション、シンボリックリンク）を作ってはいけません。`R-review-common.md` の末尾の「一時ディレクトリの扱い」を読んでから始めてください。
- Git は、表示だけのコマンドを使ってください。
  - 使ってよいのは、`git status`、`git diff`、`git log`、`git show`、`git blame` です。
  - commit、push、checkout、restore、reset、stash、switch、worktree は禁止です。
- テストの実行
  - `npm run build` は、実行しないでください。
  - テストは、対象を絞って、`npx vitest run <対象ファイル>` で実行してください。
  - `npm run typecheck` は、実行してかまいません。
- インターネット上のサイトには、アクセスしないでください。とくに 本来の監査対象のサイトへのアクセスは禁止です。
  - `config/targets/` の実サイトの設定と、`local/` 配下のファイルは、使わないでください。
  - 検証は、ローカルの fixture と `127.0.0.1` のサーバだけで行ってください。

## 対象

- 設計書:
  - `doc/design/2026-09-25-beaksight-pre-task-18-cleanup-design.md`（とくに第4章と 4.5）
  - `doc/design/2026-09-25-beaksight-pre-task-18-cleanup-implementation-plan.md`
- 上位の文書:
  - `doc/design/2026-08-27-beaksight-implementation-tasks.md`（Safety Invariants、完了の意味、SSOT Owner Matrix の Passive HTTP authority）
  - `doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md` の 4.5.5、5.6
- 共通部品台帳: `doc/design/beaksight-shared-components.md`
- 実装:
  - 新規 `src/orchestration/passive-session-open.ts`
  - `src/orchestration/passive-session-close.ts`
  - `src/orchestration/preflight.ts`、`environment.ts`、`stress-session.ts`、`page-auditor.ts`、`run-coordinator.ts`
  - `src/crawl/site-metadata.ts`
  - `src/interaction/isolated-auditor.ts`
  - `src/evidence/layout-collector.ts`
  - `src/core/limits.ts`、`src/core/contracts.ts`、`src/safety/safety-ledger.ts`（P18b の型の変更）
  - 参照: `src/safety/passive-request-guard.ts`、`src/browser/context-factory.ts`（変えていないはずのもの）
- 報告（作業記録置き場 `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`）:
  - `P18a-report.md`、`P18b-report.md`、`P18c-report.md`、`P18d-report.md`
  - 報告の中の「設計者の判断」は、設計者が承認した事項です。

## とくに確かめること

1. **安全の境界が変わっていないこと**
   - Guard と factory のファイルが、変わっていないこと。`git diff` で、`src/safety/passive-request-guard.ts` と `src/browser/context-factory.ts` に、今回の変更がないことを確かめてください。
   - 期限を過ぎた後も、Guard がリクエストを止め続けること。
     - Context を閉じる処理が終わらない間の、phase、listener、route を確かめてください。
     - 作成が期限を過ぎた後に、遅れて届いた Context が閉じられること。閉じる処理が終わらない場合も、Guard が止め続けること。
   - 期限を過ぎたことを、違反（`ABORTED_BY_SAFETY`）にしていないこと。一方で、本当の違反の記録は、今までと変わらないこと。
   - Interaction の凍結の失敗の後の無効化（`failClosed`）を、待つのをやめた場合に、凍結が解けないこと。
2. **止まり続ける経路が残っていないこと**
   - Context と page の作成と終了の、すべての呼び出し箇所に、期限があること。
     - P18a と P18c の報告の一覧と、実際のコードを照らしてください。
     - 見落としがあれば、ファイル:行で挙げてください。
   - 作成と終了が終わらない偽の Browser や Context で、Run が期限の中で確定して返ること。
3. **完了の正直さ**
   - 期限切れが、未完了の理由として、Run とページに正しく残ること。`COMPLETE` にならないこと。
   - DEF-009: 同じ Run のディレクトリがある場合に、対象のサイトにアクセスせず、`FAILED` になり、前の Run の artifact を変えないこと。
   - R15r-3: 例外の経路でも、実行時間の超過が記録されること。
4. **型の変更（P18b）**
   - 違反の形が、core の1か所だけで定義されていること。
   - Ledger の分類の名前の型が、事象の種類に絞られていること。数えられなかった遮断の分類の名前が `string` のまま残っているのは、P18e で直す予定です（設計者の判断）。
   - 振る舞いと JSON の形が変わっていないこと。
5. **テストの質**
   - 期限のテストが、実際の時間を待たないこと。
   - テストが、期限の実装の誤り（期限を付け忘れる、遅れて届いた Context を閉じない、など）を検出できる形であること。

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
