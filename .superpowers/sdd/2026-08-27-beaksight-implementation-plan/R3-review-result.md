# R3 Task 1〜5 と型・スキーマの再レビューの結果（2026-09-23）

総合判定: 承認（Critical 0 / Important 0 / Minor 7）

## 前回の指摘の解消

- 解消: R1〜R7、R9
- 一部解消: R8。fixture のカウンタは直った。ただし、ブラウザからのリクエストがサーバに届かないことを確かめる統合テストがない。

SSOT、Target Isolation、Completion Semantics は問題なかった。

## 新しい指摘と、設計者の判断

- **M1**: 設定の検証とスキーマが、ビューポートの幅・高さ、`stressWidths`、`interactionTimeoutMs` に小数を受け入れる。実行時の処理は整数を前提にしている。→ F07 で、正の整数だけを受け付けるように直す。
- **M2**: OPTIONS と独自メソッドがサーバに届かないことの統合テストがない。→ Task 18 の Safety Gate S02 で確かめる。設計書 6.7 に明記する。
- **M3**: `classifyUrl` が、認証情報を伏せ字にせずに `rawUrl` に入れる。→ F07 で直す。
- **M4**: Link の Evidence に、件数と長さの上限がなく、切り捨ての記録もない。→ F07 で直す。
- **M5**: 次の3点が決まっていない。→ F07 で直す。
  - ページの identity として持つ項目（要求したURL、最終URL、HTTP の状態）と、`pageUrl` が何を指すか
  - `viewport` の型
  - 正規化と受け入れ判定の理由のコード
- **M6**: `safety.blockedActions` の件数は、記録の上限があるため下限にしかならない。→ F07 で、そのことを型の説明に明記する。
- **M7**: 古いコメントが残っている（`schema-validator.test.ts:1087`）。→ F07 で直す。

## 再実行の記録

- unit と discover-links: 507件が PASS した。
- fixture-server・passive-request-guard・context-factory: 154件が PASS した。
- typecheck が PASS した。
