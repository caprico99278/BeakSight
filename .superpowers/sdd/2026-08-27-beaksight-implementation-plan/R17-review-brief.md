# R17 指示書: Task 17（CLI）の独立レビューと、R16 の指摘の修正（R16f）の確認

あなたは、BeakSight リポジトリ（`C:\Develop\github-repo\BeakSight`）の独立レビュー担当です。BeakSight は、Node.js 24、TypeScript strict、Playwright Library、Vitest、Ajv、fflate の CLI です。

このレビューには、2つの目的があります。

1. Task 17（CLI）のレビュー
2. Task 16 の独立レビュー R16 の指摘の修正（R16f）が、指摘を解消しているかの確認

Critical と Important がなければ、Task 18 の前の整理に進みます。

## 厳守事項

- ファイルを一切、編集も作成もしないでください（読み取り専用）。
  - 検証用のスクリプトや出力は、リポジトリの外（一時ディレクトリ）に置いてください。
  - 一時ディレクトリに、リポジトリへのリンク（ジャンクション、シンボリックリンク）を作ってはいけません。`R-review-common.md` の末尾の「一時ディレクトリの扱い」を読んでから始めてください。
- Git は、表示だけのコマンドを使ってください。
  - 使ってよいのは、`git status`、`git diff`、`git log`、`git show`、`git blame` です。
  - commit、push、checkout、restore、reset、stash、switch、worktree は禁止です。
- テストの実行
  - `npm run build` は実行しないでください。リポジトリの `dist/` を書き換えないためです。
  - CLI を実際に動かす場合は、テストの補助（`tests/helpers/temporary-build.ts`）と同じく、`node_modules/.cache` の下の一時ディレクトリにビルドしてください。終わったら、そのディレクトリを削除してください。
  - テストは、対象を絞って、`npx vitest run <対象ファイル>` で実行してください。
  - `npm run typecheck` は、実行してかまいません。
- `npx` は、導入済みのコマンドだけに使ってください。
- インターネット上のサイトには、アクセスしないでください。とくに 本来の監査対象のサイトへのアクセスは禁止です。
  - `config/targets/` の実サイトの設定と、`local/` 配下のファイルは、使わないでください。
  - 検証は、ローカルの fixture と `127.0.0.1` のサーバだけで行ってください。

## 対象

- 設計書:
  - `doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md` の第7章、6.1.5、6.1.8〜6.1.11
  - UI追補設計書 `doc/design/2026-09-23-beaksight-ui-ssot-design.md`（とくに GATE-UI01 と GATE-UI06）
  - `doc/design/2026-09-24-beaksight-task-16-17-implementation-plan.md`（末尾の追補を含む）
- 上位の文書:
  - `doc/design/2026-08-27-beaksight-implementation-tasks.md`（完了の意味、ARCH02、ARCH05、ARCH08、禁止事項）
  - `doc/design/2026-08-27-beaksight-implementation-plan.md` の Task 17
  - `doc/design/2026-08-27-beaksight-web-audit-design.md` の第19章、第20章
- 共通部品台帳: `doc/design/beaksight-shared-components.md`
- 実装:
  - `src/cli/`（`index.ts`、`main.ts`、`arguments.ts`、`output.ts`、`output-stream.ts`、`run-command.ts`、`exit-codes.ts`）
  - `src/config/config-error.ts`、`src/config/load-config.ts`
  - `src/presentation/messages.ts`、`src/presentation/catalog.ts`
  - R16f と C17a で変えた、`src/report/html-report.ts`、`html-components.ts`、`chatgpt-bundle.ts`、`view-model.ts`、`src/core/limits.ts`、`src/audit/*-rules.ts` の一覧の書式
  - `tests/architecture/ui-ssot.test.ts`、`tests/unit/cli.test.ts`、`tests/integration/cli.test.ts`、`tests/helpers/temporary-build.ts`
- 報告（作業記録置き場 `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`）:
  - `R16-review-result.md`、`R16f-report.md`、`U17a-report.md`、`C17a-report.md`
  - 報告の中の「設計者の判断」は、設計者が承認した事項です。

## とくに確かめること

1. **R16 の指摘の解消**
   - 指摘1・2・3・5・6 のそれぞれが、解消・一部解消・未解消のどれかを、根拠とともに判定してください。
   - 指摘1（Safety の事象の URL）は、とくに確かめてください。
     - 危険な値を入れた Run を実際に描き、Safety の節の中に、遮断した操作の URL へのリンクが1つもないことを確かめてください。
   - 指摘4は、DEF-009 として登録済みです。判定の対象外です。
2. **終了コードと完了の正直さ**
   - 終了コードが、最終の Run Status だけで決まること。
   - サイトの ERROR の Finding の件数で決まらないこと。
   - スキーマに合わない artifact があって Run Status が導き直された場合に、導き直した後の Run Status で終了コードが決まること。
   - 書き出しの失敗と予期しない例外が、終了コード 1 になること。
   - どの経路でも、スタックトレースが出ないこと。
3. **設定のエラー**
   - 設定と引数の誤りが、すべて CONFIG_ERROR（4）になること。
   - 利用者に、日本語の短い文言で示されること。
   - `--headed` と `--headless` の排他。未知の引数とコマンド。`--help`。
   - 設定の値の決め方（ARCH02）が、CLI の上書きで崩れないこと。
4. **CLI の処理の順序と owner**
   - 書き出しの順序が、設計書 6.1.8 のとおりであること。
   - CLI が、判定や件数の数え直しをしていないこと（UI04）。件数は、表示用モデルから取っていること。
   - 書き出しの owner が、`ArtifactWriter` だけであること（ARCH08）。
5. **プロセスの終わり方**
   - 表示を書き終えてから終わること。
   - Chromium が残った場合も、プロセスが終わること。
   - 途中で例外が起きた場合に、Browser が閉じられること。
6. **UI Gate**
   - UI01（CLI の分）と UI06 が、誤りを実際に検出できること。
     - 可能なら、リポジトリの中で対象を絞ったテストの実行と、読み取りだけで判断してください。
     - ファイルを変えて確かめる方法は、使わないでください。
   - UI Gate の各ファイルが、1秒以内に終わること。
7. **CC-016**
   - 一覧の書式が、`messages.ts` の1か所にあること。
   - Finding の文言が、変わっていないこと。
8. **テストの質**
   - テストが、実装の誤りを検出できる形であること。
   - CLI の統合テストの実行時間が、妥当であること。

## 報告

意味の通る日本語で、次の形式で返してください。全体で3000字程度までとし、重要度の高いものを優先してください。

- 総合判定: 承認 / 修正が必要
- R16 の指摘ごとの判定: 解消 / 一部解消 / 未解消（根拠付き）
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
