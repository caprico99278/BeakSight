# T19a 指示書: 専用の fixture のサイトと、本物の CLI での全体の監査の結合テスト

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。末尾の「一時ディレクトリの扱い」も守ってください。

## サブタスク

- ID: T19a
- 目的: 本物の CLI（一時ディレクトリにビルドした `dist/cli/index.js`）で、わざと壊した専用の fixture のサイトを最後まで監査し、`COMPLETE`、期待した Finding、安全の違反がないことを確かめる結合テストを作る。
- 設計書: `doc/design/2026-09-25-beaksight-task-19-fixture-full-crawl-readme-design.md` の **第4章**（必ず全部読むこと）
- 実装計画: `doc/design/2026-09-25-beaksight-task-19-fixture-full-crawl-readme-implementation-plan.md` の T19a
- 上位の実装計画: `doc/design/2026-08-27-beaksight-implementation-plan.md` の Task 19 の Step 3
- 共通部品台帳: `doc/design/beaksight-shared-components.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。このサブタスクは、ほかの実装者と並行ではありません。

## 作業

1. **fixture のサイトを作る**（`fixtures/site/full-crawl/`）
   - 設計書 4.1 のとおり。入口は `/full-crawl/index.html`。深さ2以上。
   - 壊した箇所の種類ごとに、どの Rule が検出するかを `src/audit/rule-catalog.ts` と各 Rule のファイルで確かめ、その Rule が確実に Finding を出す作り方にする。既存の fixture のページ（`auditor-hub.html` から届くページなど）の作り方を参考にしてよい。
   - 対照のページ（壊した箇所なし）と、安全に確かめられる Interaction の候補を置く。
   - 外部の Origin への読み込み、外部スキーム、フォーム、ダウンロード、変更系のリクエストを置かない。
   - 既存の fixture のページへリンクする場合は、そのページから先のリンクで、届くページの一覧が変わらないことを確かめる。
2. **結合テストを作る**（`tests/integration/fixture-full-crawl.test.ts`）
   - 設計書 4.2 のとおり。`run --config <一時的な設定> --output <一時ディレクトリ> --headless` を、別のプロセスで動かす。**必ず `--headless` を付ける。**
   - 設定は、製品の既定値のまま、`site`（入口と許可 Origin）と出力先だけを変える。`maxPages` は、見つかるページの数より大きくする。時間が長すぎて値を減らす場合は、減らした値と理由を報告する。
   - 確かめること（設計書 4.2 の一覧のすべて）:
     - 終了コード 0、Run Status `COMPLETE`
     - 監査したページの一覧が、期待した一覧と完全に一致する
     - 壊したページごとに、期待した ruleId の Finding が出る
     - 対照のページに Finding が出ない
     - Guard が有効、不変条件の違反が0件
     - fixture のサーバに届いたリクエストが GET と HEAD だけ
     - `run.json`、`audit.json`、`report.html`、各 `page.json`、バンドルがあり、スキーマに合う
     - プロセスが期限の中で終わり、スタックトレースを出さない
   - CLI のプロセスの起動の処理が `tests/integration/cli.test.ts` と同じになる場合は、`tests/helpers/` の新しいファイル（例: `cli-process.ts`）に移し、両方のテストで使う。移したときは、`cli.test.ts` の件数とテストの名前が変わらないことを確かめる。
3. **実行の時間を記録する**（テストのファイル全体と、CLI のプロセス）。

## 見つかった不具合の扱い

- Task 1〜18 の部品の不具合が見つかったら、**その場で直さない。** 発見事項として報告する。テストが通らなくなる場合は、Blocker として止まる。
- `COMPLETE` にならない原因が fixture の作り方である場合は、fixture を直してよい。製品の判定を緩めてはいけない。どちらか分からない場合は、止まって報告する。

## TDD の進め方

- 先に、結合テストの期待（ページの一覧、ruleId、対照、安全）を書き、fixture がない状態で RED を確かめる。
- fixture を足して GREEN にする。
- 各期待が空振りしていないことを確かめる（例: 壊した箇所を一時的に直すと、その ruleId の確かめが失敗すること。確かめたら元に戻す。確かめた方法を報告する）。

## 変えてよいファイル

- `fixtures/site/full-crawl/*`（新規）
- `tests/integration/fixture-full-crawl.test.ts`（新規）
- `tests/helpers/` の新しいファイル（CLI のプロセスの起動を共有する場合）
- `tests/integration/cli.test.ts`（共有の補助を使う形にする場合だけ）
- 上に無いファイル（`src/`、`fixtures/server.ts`、既存の fixture のページなど）を変える必要が出たら、Blocker として止まる。

## 使うべき共通部品（台帳から）

- `buildIntoTemporaryDirectory`（`tests/helpers/temporary-build.ts`）: 一時ディレクトリへのビルド
- `startFixtureServer`（`fixtures/server.ts`）: fixture のサーバと、リクエストの計数
- `tests/helpers/run-harness.ts`: `readRunArtifactFiles`、`findingsOf`、`expectSchemaValid`、`expectOnlyReadRequests` など
- `RUN_ARTIFACT_FILE_NAMES` など、artifact の名前の定数（`src/core/artifact-layout.ts`）。ファイル名を直書きしない
- `EXIT_CODES`（`src/cli/exit-codes.ts`）

## 受け入れ条件

- 結合テストが PASS し、設計書 4.2 の確かめをすべて含む。
- 各期待が空振りしていないことを確かめ、その方法を報告している。
- 既存のテストのケースを消していない。確かめる内容を弱めていない。
- `npm run verify` が PASS する。
- すべての Gate（S、A、ARCH、UI）が PASS する。

## 厳守事項

- **Chromium は headless だけで起動する。** CLI には必ず `--headless` を付ける。headed で起動してはいけない。
- 本来の監査対象のサイトを含む、実在の外部のサイトにアクセスしない。`config/targets/` と `local/` の実サイトの設定を使わない。
- `git commit`、`git push`、HEAD に戻す操作は禁止。
- 依存パッケージを追加・更新しない。ブラウザをインストールしない。
- Blocker に当たったら、回避策を自分で考えずに止まり、報告する。

## 報告

共通ルールの形式で、日本語で報告してください。次のものを入れてください。

- fixture のページの一覧（ページごとの壊した箇所と、期待した ruleId）
- 監査で見つかったページの一覧と、Finding の一覧（ruleId とページ）
- 空振りしないことの確かめの方法と結果
- 実行の時間
- `npm run verify` の結果（ファイル数、件数）
- 発見事項（Task 1〜18 の部品の不具合の疑いを含む）
