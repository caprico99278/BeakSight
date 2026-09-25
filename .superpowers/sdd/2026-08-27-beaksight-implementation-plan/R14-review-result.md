# R14 Task 14 のチェックポイントの独立レビューの結果（2026-09-24）

総合判定: 修正が必要（Critical 0 / Important 2 / Minor 4）

## 問題がないと確かめられた点

- Passive で、GET 以外（POST、sendBeacon、PUT、遅れて送る DELETE）がサーバに届かない。
- Interaction の POST は、`BLOCKED_BY_SAFETY` になる。
- 採番器を共有して2ページを監査しても、ID が重複しない。
- 候補が30件のページも、5.7秒で終わる。予算の理由も、記録される。
- どの経路でも、Context とブラウザのプロセスが残らない。
- 処理の順序、Link の記録の回数、幅の走査、SKIPPED の集計、期限の計算の1か所、enum とスキーマの一致が、設計どおりである。

## 指摘と、設計者の判断

- **I1（Important）期限のない段階が、ページの期限を守らない**
  - 問題: dom、color、screenshot、links、interaction-discovery の段階は、crash としか競わせていない。そのため、メインスレッドが止まったページでは戻らない。
    - 再現: 70秒の busy loop があるページで、`audit()` に 140.8 秒かかった。
  - 判断: P14e で直す。
    - 各段階を、ページの期限まで `awaitBeforeDeadline` で待つ。crash とも競わせる。
    - 期限を過ぎた場合の扱い:
      - `<段階>:DEADLINE_EXCEEDED` を記録する。
      - ページの中の残りの段階は、行わない。
      - Context を閉じる。止まったページも、Context を閉じれば終わる。
      - 集めた Evidence で、Safety の Evidence を作り、Rule を評価する。
    - 設計書 4.5.7 に書いた。
- **I2（Important）Context の構築に失敗したときの Ledger が、Safety の集計から漏れる**
  - 判断: P14e で直す。
    - `factory.getSafetyLedger(error.context)` を、集計と Evidence に含める。
    - Interaction の側で捨てていた、閉じる処理の失敗も、理由として記録する。
- **m1 最後の段階の後に crash すると、`PAGE_CRASHED` の理由がない**
  - 判断: P14e で直す。
- **m2 設定で、ページの期限が Interaction の見積もりより短くても通る**
  - 判断: P14e で直す。
    - Interaction が有効なら、`overallPageTimeoutMs >= navigationTimeoutMs + 2 × interactionTimeoutMs` を検証し、満たさない設定を拒む。
    - 倍数の定数は、`src/core/limits.ts` に移す。
    - 既定の設定（30000 + 6000 ≤ 60000）は、この条件を満たす。
- **m3 共通部品台帳に、P14b の部品がない**
  - 判断: 設計者が更新した。
- **m4 テストの質**
  - 判断: P14e で直す。
    - Context の残りを、黙って閉じず、テストで確かめる。
    - 0件でも真になる `every` を直す。
    - Page Auditor を通して、GET 以外を遮断するテストを加える。

## 再実行の記録

- 関係する14ファイルで、793件が PASS した。
- 検証用のテスト（busy loop、Ledger の漏れ）で、I1 と I2 を再現した。
