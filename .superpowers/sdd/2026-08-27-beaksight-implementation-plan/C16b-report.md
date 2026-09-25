# C16b 実装報告（要約。設計者が保存）

## 結論

完了した。実装者の報告では、`npm run verify` は PASS した（81ファイル、2732件。todo 1件）。

- Run の見本の組み立てを、`tests/helpers/audit-run-fixture.ts` にまとめた。
- `view-model.test.ts` と `artifact-writer.test.ts` は、この補助を使う形にした。
- 置き換えの前後で、PASS の件数は同じである（27件と20件）。`it(` と `expect(` の数も同じである。
- 補助のテストを21件加えた。

設計者の確認:

- 3つのファイルで68件が PASS した。
- `npm run typecheck` が PASS した。
- `src` は変更していない。

## 補助の要点（U16c・U16d・U17a 向け）

- 定数
  - `FIXTURE_ORIGIN`、`FIXTURE_OBSERVED_AT`、`FIXTURE_RUN_ID`、`PAGE_1`〜`PAGE_3`
  - `HOSTILE_STRINGS`、`HOSTILE_TEXT`、`SPECIAL_SCHEME_URLS`、`JAPANESE_TEXT`
- Evidence: `record`、`dom`、`screenshot`（`retryAttempt` を引数に取る）、`interaction`、`metadata`、`safety`
- Finding とページ: `finding`、`viewportResult`、`page`
- Run: `retry`、`runStatusInput`、`runSummary`、`auditRun`、`edgeCaseAuditRun`
  - `edgeCaseAuditRun` は、HTML とバンドルのテスト用の見本である。次のものを含む。
    - 危険な文字列
    - `mailto:` と `tel:` の URL
    - 再試行したページ
    - すべての severity
    - Run Status は `PARTIAL` である。
- 返す値は、呼ぶたびに新しく作り、凍結しない。

## 実装者の判断と、設計者の判断

1. 場面ごとの組み立ては、各テストファイルに残した。→ 承認する。期待値の前提になるデータは、テストの近くに置くのがよい。
2. view-model のテストの Evidence を、スキーマに合う完全な payload にした。→ 承認する。期待値は変えていない。
3. artifact-writer の Finding の元の値を、上書きの引数で保った。→ 承認する。
4. `safety` の見本は、`SafetyLedger` から作った。→ 承認する。形を複製しない。

## 発見事項と、設計者の判断

1. 共通部品台帳に、補助の行がない。→ 設計者が加えた。
2. COMPLETE の入力の見本が、ほかの3つのテストファイルにもある。→ 共通化候補 CC-025 として登録した。
   - 実施は、Task 18 の前の整理とする。
3. スキーマの検証のテストの見本は、目的が違うので、そのままにする。→ 承認する。
