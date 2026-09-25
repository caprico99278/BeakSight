# C18d 実装報告（要約。設計者が保存）

## 結論

完了した。実装者の報告では、`npm run verify` は PASS した（97ファイル、3,520件）。`src/` は、変えていない。

- CC-029: テストの補助を、`tests/helpers/` の次の3つにまとめた。対象のテストファイルは、まとめた補助を使う形にした。
  - `run-harness.ts`: Run の起動、CLI での Run、artifact の読み取り、確かめ方
  - `browser-proxies.ts`: Browser の Proxy
  - `external-scheme-fixture.ts`: 外部スキームの宛先、経路、試験用のパス、期待値の組み立て
  - `chromium.ts` には、`launchHeadlessChromium`、`SITE_PER_PROCESS_ARGS`、`oopifTargetUrls` を加えた。
- 置き換えの前後で、各ファイルの PASS の件数は同じだった。
  - 増えたのは、M2 の1件と、M3 の3件だけである。
  - 経路の名前の書き方をそろえたため、`external-scheme-navigation` の42件のテストの名前が変わった。
- ハブのページ `fixtures/site/auditor-hub.html` を加えた。
  - Auditor の Gate の Run は、8から5に減った。
  - 実行時間は、52.7秒から42.7秒になった。
  - Gate の確認と対照の確認は、弱めていない。A02 の対照は、広げた。
- M2: GATE-S03 の入れ子の OOPIF の確認と、OOPIF の Interaction の段階の確認（1件）を加えた。
- M3: fail-closed の3つの分岐のテストを加えた。
  - 事象を書き換える Proxy で、分岐を起こした。
  - 書き換えない写しでは FAIL することを確かめ、空振りしていないことを示した。

## 実装者の判断と、設計者の判断

1. `createRunLauncher` は、要求の値にかかわらず、いつも headless で起動する。要求は `calls` に記録する。→ 承認する。安全の面で良い。
2. `auditor-gates` の CLI の出力先を、`--output` で渡す形にした。→ 承認する。
3. 完了の意味のテストは、CLI のハブの Run で確かめる形にした。確認を、Rule の ID で強めた。→ 承認する。
4. `expectSchemaValid` と `expectOnlyReadRequests` の確かめる範囲を広げた。→ 承認する。
5. crawl-run の閉じる処理のテストで、`screenshots: true` を明示して残した。→ 承認する。振る舞いを変えないためである。
6. ハブの fixture の名前。→ 承認する。

## 発見事項と、設計者の判断

1. `fixtures/server.ts:76` のコメントが、移る前の場所を指している。宛先の値の複製もある。
2. 範囲の外の複製がある。
   - `tests/unit/cli.test.ts:518` の `capture`
   - `tests/integration/report-generation.test.ts:31` の launcher（要求の headless の値をそのまま渡す）
   - `tests/integration/environment.test.ts:55` の `browserWithHangingNewContext`
   - `tests/component/discover-links.test.ts:17` の `chromium.launch()`
3. 対象のファイルの中の重複が残っている。
   - `QUIET_PERIOD_MS`
   - headless と headed の注入の組み合わせ
   - Guard の付いた Passive の page を開いて閉じる処理

→ 1〜3 は、CC-031 として登録した。C18k で直す。

4. 共通部品台帳の直し。→ 設計者が行った。
