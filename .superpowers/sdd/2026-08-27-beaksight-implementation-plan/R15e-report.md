# R15e 実装報告（要約。設計者が保存）

## 結論

完了した。I2、I1、Minor-3、Minor-4、Minor-6 を直した。実装者の報告では、`npm run verify` は PASS した（71ファイル、2487件）。

- Coordinator は、`createSafetyLedger` を包み、Run の間に作ったすべての Ledger を登録する。Safety の集計は、その登録からだけ行う。
- `deriveRunStatus` は、違反の判定（件数が1以上）を、`preflightFailed` より先に行う。
- 最後のページで実行時間の上限を超えた場合は、`crawlLimits.maxRuntimeReached` を真にする。監査していない URL が残らない場合は、理由を付けない。
- 最初の試行の Evidence を、最終のページに残し、`retries[].evidenceIds` で参照する。
- 実装を10通りに壊し、どれもテストが失敗することを確かめた。

## 実装者の判断と、設計者の判断

1. 違反の件数が不正な値（NaN など）の場合は、`preflightFailed` の判定の後に、`ABORTED_BY_SAFETY` とする。→ 承認する。
   - 既存のテストが、この振る舞いを固定している。
   - 不正な値の場合も、結果は `FAILED` か `ABORTED_BY_SAFETY` になり、どちらも `COMPLETE` にはならない。そのため、fail-closed の側である。

## 発見事項と、設計者の判断

1. 設計書 5.6.5 に、古い一文が残っている。→ 設計者が直した。
2. `preflight.ts` の `safetyLedgers` と、`environment.ts` の `onSafetyLedger` の説明が古い。→ C15x で直す。
3. 再試行すると、スクリーンショットが上書きされる。そのため、最初の試行の `screenshot` の Evidence が、別の試行の画像を指す。
   - 判断: 既存不具合 DEF-007 として登録する。C15x で直す。
     - 再試行の前の試行のスクリーンショットは、`pages/<pageId>/retry-<n>/<ビューポート>/` に置く。
     - 最終の試行のものは、これまでの場所に置く。
4. Task 16 以降は、`pages[].evidence` のうち、最初の試行の Evidence を区別する必要がある。
   - 判断: 設計書 第6章に、区別のしかたを書いた。区別には、`retries[].evidenceIds` を使う。
