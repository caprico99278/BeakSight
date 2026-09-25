# P18e 実装報告（要約。設計者が保存）

## 結論

完了した。実装者の報告では、`npm run verify` は PASS した（89ファイル、3141件）。Guard と factory は、変えていない。`safety-ledger.ts` の変更は、型だけである。

1. 期限の値の検証を、`src/core/deadline.ts` の `resolveTimeoutMs` に移した。`passiveTimeoutMs` は消した。
2. テスト補助の `closePassiveResources` に、`pageCloseTimeoutMs` を加えた。実時間を待っていたテストは、7,412ms から 2,884ms になった。
3. CC-028 の残り
   - 型を2つ加えた: `SafetyLedgerUncountedBlockedRequestCategory`、`SafetyLedgerReachedCategory`
   - 値と JSON は、変えていない。
4. CC-025
   - `status.test.ts` と `safety-ledger.test.ts` を、`runStatusInput()` を使う形にした。
   - `run-coordinator.test.ts` には、見本がなかった。
5. BOM を、`'\uFEFF'` の表記にした。
6. RP18 の指摘1
   - 環境の読み取りに、省略できない受け取り口 `onCloseFailure` を加えた。
   - Run Coordinator は、受け取った閉じる処理の失敗を、`unhandledFailureReason` で Run の理由にする。detail は、`environment-context-close:…` か `environment-page-close:…` である。
   - ほかの呼び出し元に、閉じる処理の期限切れを捨てて COMPLETE になる所は、なかった。
7. RP18 の指摘2
   - `RunCoordinatorDependencies.deadlines` を加え、PREFLIGHT、環境、サイトの metadata、Page Auditor に渡す。
   - 実際の Chromium で、環境の読み取りの Context の終了を止めたテストを加えた。Run は COMPLETE にならない（4.7秒）。
     - 理由の記録を一時的に無効にすると、このテストが失敗することを確かめた。
8. RP18 の指摘3
   - 幅の走査で、Context があれば閉じてから投げる形にした。
   - 閉じる処理も失敗した場合は、`AggregateError` にまとめる。

## 実装者の判断と、設計者の判断

1. 環境の読み取りの失敗は、返り値に載せず、省略できない受け取り口で渡す。→ 承認する。
   - 返り値の `RunEnvironment` は、run.json の形である。項目を加えると、スキーマが変わる。
   - 口を省略できないので、失敗を捨てる誤りは、型で防げる。
2. Browser を閉じる期限は、`browserCloseTimeoutMs` を使い回し、PREFLIGHT にも渡す。→ 承認する。同じ意味の項目を2つ作らない。
3. `RangeError` の文言を、汎用の文にした。→ 承認する。
4. 受け取り口が投げた例外は、封じ込めない。→ 承認する。呼び出し側の誤りである。
5. 実際の Chromium のテストは、Browser の Proxy で、環境の読み取りの Context の `close()` を止める。→ 承認する。Guard と factory には、手を入れていない。

## 発見事項と、設計者の判断

1. `tests/unit/text.test.ts:12` の文字列の中にも、見えない BOM の文字がある。→ 振る舞いに違いはない。Task 18 の後の整理で、表記を直す。
2. CC-025 が示す `run-coordinator.test.ts:1089` の見本は、今のファイルにない。→ 台帳の記述を直した。
3. テスト補助 `closePassiveResources` の Context の終了には、期限がない。→ 今は直さない。テストの中だけの話で、止まるテストもない。
4. 台帳の更新。→ 設計者が行った。
