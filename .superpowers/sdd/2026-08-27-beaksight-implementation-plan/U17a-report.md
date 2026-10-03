# U17a 実装報告（要約。設計者が保存）

## 結論

完了した。実装者の報告では、`npm run verify` は PASS した（87ファイル、3002件）。UI Gate は 324ms で終わった。

- `run` のコマンドは、次の順に行う。
  1. 設定の読み込み
  2. Run の実行
  3. 書き出し（設計書 6.1.8 の順）
  4. 日本語の結果の表示
  5. 終了コードの設定
- 作ったもの
  - `src/cli/`: `exit-codes.ts`、`arguments.ts`、`output.ts`、`output-stream.ts`、`run-command.ts`、`main.ts`
    - `index.ts` は、`runCli` を呼んで `process.exit` するだけになった。
  - `src/config/config-error.ts`: `ConfigError`（11種類）
    - `loadConfig` は、設定の誤りを、すべて `ConfigError` で投げる。
  - `messages.ts` の CLI の文言
  - UI01 の CLI の分と、UI06
- 出力を書き終えるのを待ってから、終了コードで終える。Playwright は、`run` のときだけ動的に import する。
- 既存の `tests/unit/cli.test.ts` は、新しい仕様に合わせて作り直した（18件）。
  - 実サイトの設定を読んでいたので、127.0.0.1 の一時的な設定に替えた。
- 統合テストは8件で、9.8秒で終わった。

## CLI の使い方（Task 19 の README で使う）

- コマンド:
  - `beaksight run [オプション]`
  - `beaksight validate-config [オプション]`
- オプション: `--config <パス>`、`--output <ディレクトリ>`、`--headed` / `--headless`（同時に指定すると CONFIG_ERROR）
- 終了コード: 0 完了、1 失敗（書き出しの失敗と予期しない例外を含む）、2 一部未完了、3 安全のため中止、4 設定のエラー

## Windows PowerShell での日本語の表示

| 場合 | 結果 |
| --- | --- |
| PowerShell 5.1 のコンソールに直接表示 | 読める |
| PowerShell 5.1 でパイプかリダイレクト（`[Console]::OutputEncoding` が既定の 932） | 文字化けする |
| 同じ操作で、`[Console]::OutputEncoding` を UTF-8 にした場合 | 読める |
| cmd.exe のコンソールに直接表示 | 読める |
| cmd.exe でリダイレクト | UTF-8 のバイト列のまま書かれる |

→ **設計者の判断: README で案内する**（案1。設計書 第7章に書いた）。

- パイプやリダイレクトの前に、`[Console]::OutputEncoding = [System.Text.Encoding]::UTF8` を実行するよう案内する。
- 結果は、UTF-8 の report.html と JSON で見ることも勧める。
- CLI の側で、コンソールのコードページを変えることはしない。利用者の環境を、実行の後まで変えてしまうためである。

## 実装者の判断と、設計者の判断

1. 設定のエラーの種類（`CONFIG_ERROR_KINDS`）は、`config-error.ts` に置いた。`messages.ts` の説明に書き漏れがないことは、`config-error.ts` の側で型で確かめる。→ 承認する。
   - UI追補設計書 4.1 の import の制限に合う。
2. CLI の引数の誤りを、4種類に分けた。→ 承認する。
3. `--help` を作らなかった。→ **C17a で作る。**
   - 使い方を示し、終了コード 0 にする。
   - README の案内で、使い方の確かめ方として使うためである。
4. HTML の要約の文言（`HTML_REPORT_TEXT.summary`）を、CLI でも使った。→ **C17a で名前を直す。**
   - HTML と CLI の両方の要約の文言として、共通の名前（例: `RUN_SUMMARY_TEXT`）に移す。
5. `validate-config` の成功を、`SUCCESS_EXIT_CODE`（= COMPLETE の 0）にした。→ 承認する。
6. Run のディレクトリは、結果の行で示す。→ 承認する。

## 発見事項と、設計者の判断

1. severity の絞り込みが、2か所にある（`view-model.ts:351`、`cli/output.ts`）。→ C17a で、カタログの補助の関数（`severitiesInGroup`）にまとめる。
2. Run の ID が秒の単位である。→ 登録済みの DEF-009 である。
3. 一時ビルドに `package.json` がない。統合テストで写して対処した。→ C17a で、テストの補助（`temporary-build.ts`）で写す形にし、統合テストの対処は消す。
4. 共通部品台帳への追記。→ 設計者が行った。
