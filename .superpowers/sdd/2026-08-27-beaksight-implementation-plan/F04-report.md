# F04 実装報告（要約。設計者が保存）

## 結論

完了した。指示書の項目1〜7を実施した。`npm run verify` は終了コード0で、38ファイル・872件のテストが PASS した。

## 主な変更

- admission-policy は、認証情報の判定に `hasUrlCredentials` を使う。
- 伏せ字の文字列を、`src/core/redaction.ts` の `REDACTED` の1か所で定義した。
- `normalize-url.test.ts` で、必ず PASS してしまうテストを、固定の期待値と比べるテストに書き直した。わざと回帰させると失敗することを確かめた。
- `limits.ts` の冒頭のコメントを直した。
- `VISIBILITY_CHECK_OPTIONS` を `src/core/visibility.ts` に移した。`contentVisibilityAuto` を false にし、RED と GREEN を確かめた。`src/evidence/visibility.ts` は削除した。
- `pageFailureReason` を、`src/browser/page-failure.ts` の1か所にまとめた。

## 発見事項と、設計者の判断

1. controlled-scroll で、`isClosed` が例外を投げたときの扱いが変わった。→ 承認する。本物の page では起きない。
2. `page-settling.ts:105` に、同じ判定が残っている。→ C8 で `pageFailureReason` に置き換える。
3. `isolated-interaction.test.ts:4402` のテストが、時刻によって失敗する（期限切れの理由の文言が揺れる）。→ C8 で直す。状態が NOT_VERIFIABLE であり VERIFIED でないことを確かめ、理由は期限切れを表すもののどれかであることを確かめる形にする。
4. 設計書と台帳の古い記述。→ 設計者が直す。
5. `dist/` に古いファイルが残る。→ Task 17 で、ビルドの前に `dist/` を消すようにする。
