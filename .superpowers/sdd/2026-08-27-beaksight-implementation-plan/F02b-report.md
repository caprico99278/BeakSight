# F02b 実装報告（要約。設計者が保存）

## 結論

完了。担当6ファイルの重複を、共通部品に置き換えた。あわせて `safeErrorMessage` に、代替文言を渡す第3引数を加えた。

- 置き換えの前の基準（308件）と、置き換えた後の関連テスト（6ファイル・309件）が PASS した。
- unit、component と、関連する integration（30ファイル・345件）が PASS した。typecheck も PASS した。
- テストの期待値は1つも変えていない。

## 置き換えなかった箇所

- CC-001 の3か所（`isolated-auditor` の `awaitInitialRender` と `observeCloseUntil`、`passive-request-guard` の `drainGuardTasks`）。いまの実装は、期限を過ぎた時刻であっても、タイマーより先に届いた決着を正とする。`awaitBeforeDeadline` に置き換えると、期限ちょうどに決着した場合の判定が変わる。
- `MAX_LEDGER_TEXT_LENGTH`、`MAX_REDIRECT_REQUEST_ID_LENGTH`、`maxAttributeLength`、矩形の誤差 0.01。いずれも、共通の値とは意味が違う。
- 配列を拒否しない object の判定と、負の値を許す期限の判定。これらも、共通部品とは意味が違う。

## 発見事項と、設計者の判断

1. isolated-auditor のエラーの文字列化が変わった（bigint と symbol の場合を含む）。→ 設計書 3.2 の範囲内として許容する。
2. `isSha256Fingerprint` は文字列であることを確かめるので、型に違反する入力に対しては、以前より厳しくなった。→ fail-closed の方向なので許容する。
3. `truncateText` は、入力が文字列かどうかを確かめない（以前の `.slice` は TypeError を投げていた）。→ C2 で、文字列でない入力に対して TypeError を投げるようにする。
4. CC-001 の3か所を共通化するかどうか。→ 共通化しない。安全性に関わる境界の意味が変わるためである。設計書 3.2 に、例外として記録する。
