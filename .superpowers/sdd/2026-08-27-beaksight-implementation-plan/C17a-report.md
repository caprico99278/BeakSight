# C17a 実装報告（要約。設計者が保存）

## 結論

完了した。実装者の報告では、`npm run verify` は PASS した（87ファイル、3016件）。UI Gate は 338ms で終わった。

1. `--help`
   - `beaksight --help`、`run --help`、`validate-config --help` で、使い方を示し、終了コード 0 で終わる。
   - 設定は読まない。使い方の文言は、引数の誤りのときと同じ `usageLines()` を使う。
2. 要約の文言
   - HTML と CLI で共通の文言を、`RUN_SUMMARY_TEXT` に移した。
   - 写しは、消した。
3. severity の絞り込み
   - `severitiesInGroup(group)` を、カタログに置いた。
   - `view-model.ts` と `cli/output.ts` は、この関数を使う。
4. 一時ビルドの `package.json`
   - `temporary-build.ts` で写す形にした。
   - 統合テストの中の対処は、消した。
5. CC-016
   - `listText` と `truncatedListText` を、`messages.ts` に置いた。
   - Rule のファイルの `.join('、')`（18か所）と、`cliListText` を置き換えた。
   - UI Gate に、`messages.ts` の外の `.join('、')` を検出する検査を加えた。

表示される文字は、変わっていない。修正の前後で、11項目の出力がバイト単位で一致することを確かめた。

- 使い方
- `runSummaryLines`
- HTML
- 表示用モデル
- 各種の CLI の行

## 実装者の判断と、設計者の判断

1. 使い方の表示に、`--help` を載せなかった。「表示される文字を変えない」という条件のためである。→ **次の整理で載せる。**
   - `--help` は新しい機能なので、使い方の表示に加えてよい。
   - 利用者が、`--help` があることを知る手段になる。
2. 「対象」（`target`）の文言も、`RUN_SUMMARY_TEXT` に移した。→ 承認する。
3. ページの項目の「未完了の理由」は、別の文言として残した。→ 承認する。意味の場所が違う。
4. 「ほか N 件」の書式は、Finding の文言を変えないため、そのままにした。→ 承認する。
5. `truncatedListText` の `maxListed` が 0 の場合だけ、前と結果が違う。→ 承認する。呼び出し側は定数 5 だけである。
6. `SUCCESS_EXIT_CODE` の説明に、`--help` が書かれていない。→ **次の整理で直す**（説明の文だけ）。
7. 共通部品台帳の追記。→ 設計者が行った。
8. `CRITICAL_SEVERITIES` は、区分の絞り込みではないので、対象から外した。→ 承認する。

## 次の整理で行うこと（R17 の結果と合わせる）

- 使い方の表示に `--help` を載せる。
- `SUCCESS_EXIT_CODE` の説明を直す。
