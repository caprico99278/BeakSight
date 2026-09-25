# R17f 実装報告（要約。設計者が保存）

## 結論

完了した。実装者の報告では、`npm run verify` は PASS した（88ファイル、3030件）。UI Gate は 332ms で終わった。

1. 出力先のエラー
   - `index.ts` で、`process.stdout` と `process.stderr` の `'error'` を無視する。
   - `uncaughtException` と `unhandledRejection` は、`reportUnhandledFailure` で、日本語の文言（`CLI_TEXT.failure.unexpected`）と1行の詳細を示し、終了コード 1 で終える。スタックトレースは出さない。
   - 実際の子プロセスで、読み口を閉じるテストを加えた。修正の前は、`Unhandled 'error' event ... EPIPE` と終了コード 1 で、RED だった。
2. 導き直した Run Status
   - `finishAuditRun(result, outputDirectory, stdout)` を切り出した。
     - 行うこと: 書き出し、表示用モデル、結果の表示、終了コード
     - 終了コードは、`written.result.run.runStatus` から決める。
   - 導き直しの前の Run Status を使う形では、テストが失敗した（`expected +0 to be 2`）。
3. オプションの重複
   - `--config` と `--output` を2回以上指定すると、`INVALID_ARGUMENTS` になる。
   - `--config=a` の形も、1回と数える。
4. BOM: 先頭の U+FEFF を1つだけ取り除いてから、`JSON.parse` する。
5. 使い方に、`--help` の行を加えた。
6. `SUCCESS_EXIT_CODE` の説明を直した。

## 実装者の判断と、設計者の判断

1. `--help` の判定は、重複の検査より先に行う。→ 承認する。`--headed` と `--headless` の同時指定と同じ扱いである。
2. 重複の日本語の文言には、既存の `INVALID_ARGUMENTS` の説明を使った。詳細は、英語の1行で示す。→ 承認する。
3. 扱われない失敗では、表示の後すぐに `process.exit(1)` する。Run Coordinator の `finally` を待たない。→ 承認する。
   - 例外が逃げた後の、最後の手段である。
   - Chromium の終了は、Playwright がプロセスの終了時に行う処理に任せる。
4. `finishAuditRun` に、結果の表示も含めた。→ 承認する。表示用モデルと終了コードを、同じ最終の Run から作るためである。
5. 共通部品台帳。→ 設計者が、`finishAuditRun` と `ignoreOutputErrors` を載せた。
