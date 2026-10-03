# U17a 指示書: 本番の CLI（Run の実行、書き出し、終了コード、設定のエラー、UI01・UI06）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。末尾の「一時ディレクトリの扱い」も守ってください。

## サブタスク

- ID: U17a
- 目的: CLI から、設定の読み込み、Run の実行、artifact・HTML・バンドルの書き出し、結果の表示、終了コードの設定までを行えるようにする。
- 設計書:
  - `doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md` の第7章と 6.1.5
  - 同じ設計書の 6.1.8・6.1.9（書き出しの順序と、`readArtifactFile` の作り方）
  - UI追補設計書 `doc/design/2026-09-23-beaksight-ui-ssot-design.md`（とくに第3章、第4章、第6章の GATE-UI01 と GATE-UI06）
- 実装計画:
  - `doc/design/2026-09-24-beaksight-task-16-17-implementation-plan.md` の U17a
  - 上位の計画 `doc/design/2026-08-27-beaksight-implementation-plan.md` の Task 17
- スキルの参照: `.claude/skills/beaksight-dev/references/ui-ux-ssot.md`（とくに第5章）
- 共通化候補: 作業記録置き場の `commonization-candidates.md` の CC-012（終了コードと設定のエラー）
- 前の報告: 作業記録置き場の次のもの
  - `U16b-report.md`、`U16c-report.md`、`U16d-report.md`
  - `C16a-report.md`〜`C16e-report.md`
  - `C15x-report.md`（Browser を閉じる処理の期限）
- 共通部品台帳: `doc/design/beaksight-shared-components.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

このサブタスクは単独で実行します。

## 変更してよいファイル

- `src/cli/index.ts`
- 新規: `src/cli/exit-codes.ts`
- 新規: `src/cli/` の中の補助のファイル（必要な場合。例えば、実行の組み立てを `index.ts` から分けるファイル）
- `src/config/`
  - `ConfigError` のクラスを置く新規のファイル（例: `src/config/config-error.ts`）
  - `load-config.ts`（`ConfigError` を投げる形にすることに限る）
- `src/presentation/messages.ts`（CLI と設定のエラーの文言を加えることに限る）
- `tests/architecture/ui-ssot.test.ts`（UI01 の CLI の分と UI06 を有効にすることに限る）
- テスト:
  - `tests/unit/cli.test.ts`（新しい仕様に合わせて直す。既存の英語の文言と終了コードは、設計書どおりに変わる）
  - 新規: `tests/integration/cli.test.ts`（fixture のサイトで CLI を実行する）
  - 新規: `tests/unit/exit-codes.test.ts`
  - 新規: `tests/unit/config-error.test.ts`
  - `tests/unit/config.test.ts`（設定の読み込みの既存のテスト。例外の型が `ConfigError` になることに合わせることに限る）

範囲外のファイル（Run Coordinator、Page Auditor、report など）の変更が必要になった場合は、止まって Blocker として報告してください。

## 作るもの

1. **終了コード（`src/cli/exit-codes.ts`）**
   - 終了コードは、この表だけが決める。
     - COMPLETE は 0、FAILED は 1、PARTIAL は 2、ABORTED_BY_SAFETY は 3、CONFIG_ERROR は 4
   - `RunStatus` のすべての値について書き、書き漏れを型のエラーにする。
   - サイトの ERROR の Finding の件数では、決めない。
2. **設定のエラー（`ConfigError`）**（設計書 6.1.5）
   - `src/config/` に置く。
   - エラーの種類のコードと、詳細の一覧を持つ。
     - 種類の例: ファイルがない、JSON として読めない、target がない・重なる、検証のエラー、CLI の引数の矛盾
   - `loadConfig` は、設定の誤りを `ConfigError` で投げる。
   - CLI は、`ConfigError` を見分け、次のように示して、終了コード 4 にする。
     - 日本語の文言（`messages.ts`）
     - 詳細の一覧（英語の検証エラーは、技術的な詳細として、そのまま）
   - スタックトレースは出さない。
   - 未知の引数と、未知のコマンドも、CONFIG_ERROR とする。使い方の日本語の文言を示す。
   - `--headed` と `--headless` を同時に指定した場合も、CONFIG_ERROR にする。
3. **`run` のコマンド**
   - 設定を読み、CLI の上書き（`--headed`、`--headless`、`--output`）を適用する。
   - Run Coordinator を組み立てて、Run を実行する。
     - 組み立て方は、Run Coordinator の既存の統合テストと、`RunCoordinator` の引数を参照すること。
   - 書き出しの順序（設計書 6.1.8）:
     1. `ArtifactWriter.writeRun`
     2. `buildReportViewModel(written.result)`
     3. `renderHtmlReport(viewModel)`
     4. `createChatGptBundle(viewModel, written.result, readArtifactFile)`
        - `readArtifactFile` の作り方は、`U16d-report.md` のとおりにする。`ENOENT` は `null` にする。
     5. `writePresentation(written, { reportHtml, bundle })`
   - 結果の表示（日本語。`messages.ts` の文言。値は表示用モデルの `summary` から取る）:
     - Run Status の日本語のラベル
     - 出力先のディレクトリ
     - ページの網羅（発見、監査、PARTIAL、失敗、スキップ）
     - サイト品質の件数（ERROR、WARN、INFO）と、Safety の件数
     - 未完了の理由がある場合は、その件数
   - 終了コードは、最終の Run Status から、`exit-codes.ts` で決める。
   - 書き出しの入出力の失敗（`ArtifactWriteError`）は、日本語の文言で示し、終了コード 1（FAILED と同じ）にする。
   - 予期しない例外も、日本語の短い文言と終了コード 1 にする。
     - 例外のメッセージは、技術的な詳細として1行で示す。スタックトレースは出さない。
4. **プロセスを確実に終える**
   - Browser を閉じる処理の期限（`BROWSER_CLOSE_TIMEOUT_MS`）を過ぎても、Chromium が残ることがある。その場合も、CLI のプロセスは、表示を書き終えた後に終わること。
   - 標準出力と標準エラーへの書き込みが終わるのを待ってから、終了コードで終える。
     - Windows のパイプへの書き込みを、途中で切らないためである。
   - 統合テストで、CLI のプロセスが、決まった時間の中で終わることを確かめる。
5. **`validate-config` のコマンド**
   - 成功の文言を、日本語にする。
   - 誤りは `ConfigError` として示し、終了コード 4 にする。
6. **UI Gate**（UI追補設計書 6.1）
   - GATE-UI01 の CLI の分を有効にする。
     - 対象は `src/cli/**` で、`src/cli/exit-codes.ts` は除く。
     - 状態の値の文字列リテラルを、直接書かない。
   - GATE-UI06 を有効にする。
     - 対象は `src/**` である。除外するのは、`src/presentation/messages.ts`、`src/presentation/catalog.ts`、`src/audit/*-rules.ts` である。
     - ひらがな・カタカナ・漢字を含む文字列リテラルがないことを確かめる。コメントは対象外とする（正規表現による近似でよい）。
     - 設計者が近似の走査で確かめた範囲では、今のコードに違反はない。違反が見つかった場合は、報告すること。
   - ファイルの一覧の取得と読み込みは、今までどおり1回だけにする。
   - ファイル全体が、1秒以内に終わること。
7. **Windows PowerShell での日本語の表示**（設計書 第7章）
   - 次の3つの場合に、日本語の出力が読めるかを確かめ、結果を報告する。
     1. Windows PowerShell 5.1 のコンソールに、直接表示する場合
     2. パイプやファイルへのリダイレクトの場合
     3. `cmd.exe` の場合（できれば）
   - 文字化けする場合は、対処の案を報告する。
     - 案の例: 出力の側で対処する方法、README で案内する方法
   - 対処の実装は、設計者の判断の後に行う。このサブタスクでは実装しない。

## テスト

- 単体テスト:
  - 終了コードの表に、すべての Run Status がある。
  - `ConfigError` が、種類と詳細を持つ。
  - `loadConfig` の設定の誤りが、`ConfigError` になる。
- CLI のテスト（`tests/unit/cli.test.ts`。一時的なビルドで CLI を起動する既存の形を使う）:
  - `validate-config` の成功と失敗
  - `--headed` と `--headless` の排他
  - 未知のコマンドと引数
  - 存在しない設定のファイル、JSON として読めない設定
  - どれも、日本語の文言、スタックトレースがないこと、終了コード 4 を確かめる。
- 統合テスト（`tests/integration/cli.test.ts`。fixture のサイトを `127.0.0.1` で起動し、それを対象にした設定を一時ディレクトリに書いて、CLI を実行する）:
  - COMPLETE の Run が、終了コード 0 で終わる。
    - サイトの ERROR の Finding があっても、0 である（上位の計画の Step 1）。
  - `--output` で出力先が変わる。
  - 出力先に次のファイルがあり、スキーマに合う。
    - `run.json`、`audit.json`、`report.html`、`beaksight-audit-bundle.zip`、各ページの `page.json`
  - 標準出力に、出力先と件数の要約がある。
  - PARTIAL の Run が、終了コード 2 で終わる（例: ページの上限で、監査していないページが残る設定）。
  - プロセスが、決まった時間の中で終わる。
  - `validate-config` 以外のテストの実行時間が長くなりすぎないように、fixture のページ数と上限を小さくする。
- UI Gate: UI01 の CLI の分と、UI06 が有効で、PASS し、1秒以内に終わる。

## 受け入れ条件

- 各テストが、修正前に RED、修正後に GREEN になる。
- テストのケースを削除したり、弱めたりしない。
  - 既存の `cli.test.ts` の英語の文言と終了コードの期待値は、設計書の新しい仕様に合わせて直す。その内容は、報告に書く。
- 共通部品台帳の部品を使い、同じ意味の処理を新しく書かない。
- `npm run typecheck` が PASS する。
- `npm run verify` が PASS する。

## 報告

共通ルールの形式で、日本語で報告してください。報告には、次のものを入れてください。

- CLI の使い方（コマンド、引数、終了コード）の一覧。README（Task 19）で使う。
- Windows PowerShell での日本語の表示の確認の結果。
