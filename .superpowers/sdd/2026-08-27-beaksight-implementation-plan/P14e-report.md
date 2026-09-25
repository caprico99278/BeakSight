# P14e 実装報告（要約。設計者が保存）

## 結論

R14 の I1、I2、m2、m4 を直した。m1 は一部を確かめた。実装者の報告では、`npm run verify` は PASS した（58ファイル、2159件。build を含む）。

- I1: 各段階を、crash と競わせたうえで、ページの期限まで待つようにした（`StageRunner`）。
  - 止まり続ける busy loop のページで確かめた（`overallPageTimeoutMs = 6000`）。
    - 監査は 13.6 秒で戻った。
    - 両方のビューポートが `PARTIAL` になり、理由は `dom:DEADLINE_EXCEEDED` だった。
    - Context は残らなかった。
- I2: Context の構築に失敗した場合も、その Context の Ledger を、Passive と Interaction の両方で集計と Evidence に含めるようにした。
  - Interaction の側で、閉じる処理の失敗も記録するようにした。
- m1: 最後の Interaction の候補の処理中に crash した場合は、`interaction:PAGE_CRASHED` を記録する。
  - 段階の外の crash（`safety`、`rules`）の扱いも実装した。ただし、決まった結果になるテストは作れなかった。
- m2: `INTERACTION_TIMEOUT_COUNT_PER_CANDIDATE = 2` を、`limits.ts` に置いた。
  - 設定の検証で、`overallPageTimeoutMs < navigationTimeoutMs + 2 × interactionTimeoutMs` の設定を拒むようにした（Interaction が有効な場合）。
- m4: Context の残りを、すべての監査の後にテストで確かめるようにした。
  - Page Auditor を通して、GET 以外（DELETE、POST、PUT）がサーバに届かないことを確かめた。
  - `SAFETY_NON_READ_REQUEST_BLOCKED` ができることも確かめた。

## 実装者の判断と、設計者の判断

1. `interaction-discovery` の段階は、Interaction の段階の期限まで待つ。→ 承認する。設計書 4.5.7 のとおり、Interaction の段階は、別の予算を持つためである。
2. 幅の走査と、Interaction の候補の監査は、途中で見放さない。→ 承認する。
   - どちらも別の Context で動き、自分で期限を守る。
   - 見放すと、その Context が残るためである。
3. 見放さない段階の途中の crash は、その段階として記録する。→ 承認する。

## 発見事項と、設計者の判断

1. 読み込みの途中で描画プロセスが落ちると、Playwright は `crash` ではなく `close` を出す。そのため、結果は `TIMEOUT` になる。
   - 段階の外の crash は、決まった結果になるテストを作れない。
   - 判断: 制約として受け入れる。設計書 4.5.4 に書いた。まれな場合である。
2. 項目どうしの算術の関係は、JSON Schema では表せない。
   - 判断: 設計書 4.5.7 の記述を、「設定の検証で確かめる」に直した。
3. 既存のテストを、新しい規則に合わせて、Interaction を無効にした形に直した。→ 承認する。テストが確かめる意味は、変わっていない。
4. 共通部品台帳に、倍数の定数を加える必要がある。→ 設計者が更新した。
