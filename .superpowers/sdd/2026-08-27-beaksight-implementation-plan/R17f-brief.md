# R17f 指示書: R17 の指摘の修正（出力先のエラー、導き直した Run Status、オプションの重複、BOM、`--help` の記載）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。末尾の「一時ディレクトリの扱い」も守ってください。

## サブタスク

- ID: R17f
- 目的: Task 17 の独立レビュー R17 の指摘4件と、C17a で持ち越した2件を直す。
- 設計書: `doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md` の第7章（R17 の指摘を受けて加えた部分）
- レビューの結果: 作業記録置き場の `R17-review-result.md`
- 前の報告: 作業記録置き場の `U17a-report.md`、`C17a-report.md`（「次の整理で行うこと」）
- 共通部品台帳: `doc/design/beaksight-shared-components.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

このサブタスクは単独で実行します。

## 変更してよいファイル

- `src/cli/`（`index.ts`、`main.ts`、`arguments.ts`、`output.ts`、`output-stream.ts`、`run-command.ts`、`exit-codes.ts`）
- `src/config/load-config.ts`（BOM に限る）
- `src/presentation/messages.ts`（文言を加えることに限る）
- テスト:
  - `tests/unit/cli.test.ts`
  - `tests/integration/cli.test.ts`
  - `tests/unit/config.test.ts`
  - `tests/unit/exit-codes.test.ts`
  - 新規の CLI の単体テストのファイル（必要な場合）

## 直すもの

1. **出力先のエラー**（R17 の指摘1。Important）
   - 標準出力と標準エラーの `'error'` を受けて、無視する。
     - 対象は、閉じたパイプ（EPIPE）などである。
     - 終了コードは、変えない。
   - 扱われない reject と例外は、次のように処理する。
     - 日本語の短い文言と、例外のメッセージの1行を示し、終了コード 1 で終える。
     - スタックトレースは出さない。
     - 出力先が閉じている場合も、落ちないこと。
   - テスト:
     - 実際の子プロセス（一時的なビルドの CLI）で、`--help` を起動し、読み口を閉じる。
       - 終了コードが 0 であること。
       - 標準エラーに、スタックトレース（`at ` で始まる行や `Unhandled 'error' event`）がないこと。
     - 修正の前に RED になること。
2. **導き直した Run Status**（R17 の指摘2。Important）
   - 確定した `AuditRunResult` から、次のことを行う関数を切り出す。
     1. 書き出し（設計書 6.1.8 の順）
     2. 表示用モデル
     3. 終了コード
   - Run Coordinator の実行とは、分ける。
   - テスト:
     - スキーマに合わない `AuditRunResult` を、この関数に渡す。
       - 例: `statusInput` では `COMPLETE` だが、page のスキーマに合わない値を持つもの。見本は `tests/helpers/audit-run-fixture.ts` で作る。
     - 導き直した後の Run Status（`PARTIAL`）から、終了コード 2 が決まることを確かめる。
   - 導き直しの前の Run Status を使う形に一時的に変えると、テストが失敗することを確かめ、報告する。
3. **同じオプションの重複**（R17 の指摘3）
   - `--config` と `--output` を2回以上指定した場合は、CONFIG_ERROR（`INVALID_ARGUMENTS`）にする。
   - 日本語の文言で示す。
4. **BOM**（R17 の指摘4）
   - `loadConfig` は、設定のファイルの先頭の UTF-8 の BOM を1つだけ取り除いてから、JSON として読む。
   - テスト: BOM 付きのファイルが、正しく読めること。
5. **使い方への `--help` の記載**（C17a の持ち越し）
   - 使い方の表示に、`--help` の行を加える。
   - 文言は、`messages.ts` に置く。
6. **`SUCCESS_EXIT_CODE` の説明**（C17a の持ち越し）
   - 説明の文に、`--help` も加える。

## 受け入れ条件

- 各修正のテストが、修正前に RED、修正後に GREEN になる。
- 既存のテストのケースと期待値を、弱めない。
  - 使い方の表示が変わるテストは、新しい行に合わせて直してよい。直したテストは、報告に書く。
- UI Gate のファイルが、1秒以内に終わる。
- `npm run typecheck` が PASS する。
- `npm run verify` が PASS する。

## 報告

共通ルールの形式で、日本語で報告してください。指摘の番号ごとに、何をどう直したかを書いてください。
