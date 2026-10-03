# P14e 指示書: ページの期限の厳守と、Safety の集計の漏れの修正

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: P14e
- 目的: Task 14 のチェックポイントのレビュー R14 の指摘（I1、I2、m1、m2、m4）を直す。
- 設計書: `doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md`
  - 4.3（構築に失敗した Context の Ledger）
  - 4.5.4（crash）
  - 4.5.7（ページの期限の守り方、設定の検証）
- レビューの結果: 作業記録置き場の `R14-review-result.md`
- 前の報告: `P14c-report.md`、`P14d-report.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

このサブタスクは単独で実行します。

## 変更してよいファイル

- `src/orchestration/page-auditor.ts`
- `src/core/limits.ts`（倍数の定数を加えることに限る）
- `src/config/validate-config.ts`
- テスト: `tests/integration/page-auditor.test.ts`、`tests/integration/page-auditor-interaction.test.ts`、`tests/unit/config.test.ts`、`tests/unit/limits.test.ts`
- `fixtures/site/` への新しいページの追加。例: 止まり続ける busy loop のページ、GET 以外を送るページ。

## 修正する内容

1. **I1 ページの期限を守る**
   - `attemptStage` などの段階の実行を、ページの期限まで `awaitBeforeDeadline`（`src/core/deadline.ts`）で待つ形にする。crash との競争は、これまでどおり行う。
   - 期限を過ぎた場合は、次のようにする。
     - `<段階>:DEADLINE_EXCEEDED` を記録し、ビューポートを `PARTIAL` にする。
     - ページの中の残りの段階は行わない。
     - Context を閉じる。
     - それまでに集めた Evidence で、Safety の Evidence を作り、Rule を評価する。
   - 期限を過ぎた後に遅れて返る結果や reject は、封じ込める。unhandledRejection を出さない。
   - fixture とテストで、次のことを確かめる。修正前に RED、修正後に GREEN になること。
     - 読み込みの後に、止まり続ける busy loop（例: `while(true){}`）を実行するページを監査する。
     - `overallPageTimeoutMs` を小さくした設定（例: 6000）で監査する。
     - `audit()` が、期限の数倍の時間以内に戻る。テストの時間の上限は、実装者が決めて報告する。
     - ビューポートが `PARTIAL` になり、`DEADLINE_EXCEEDED` の理由が記録される。
     - Context が残らない。
2. **I2 構築に失敗した Context の Ledger**
   - Passive と Interaction の両方で、`ContextConstructionError` の `error.context` の Ledger を、次の2つに含める。
     - Safety の Evidence
     - `summarizePageSafety` の入力
   - Ledger の取得には、`factory.getSafetyLedger(error.context)` を使う。
   - Interaction の側で、`closePassiveSession` が返す閉じる処理の失敗を捨てずに、理由として記録する。
   - テストで、次のことを確かめる。
     - factory の派生クラスで、Ledger に違反を1件記録してから `ContextConstructionError` を投げる。
     - Passive と Interaction のどちらでも、`invariantViolationCount` が 1 になる。
3. **m1 最後の段階の後の crash**
   - 全部の段階を終えた時点で crash が起きていて、`PAGE_CRASHED` の理由がまだない場合は、理由を記録する。
     - 段階は、crash を見つけた時点で処理中の段階とする。段階の後であれば、`rules` か `safety` とする。
   - 最後の Interaction の候補の処理中に crash した場合も、同じ扱いにする。
   - テストで確かめる。偽の collector や、crash を起こす差し替えを使ってよい。
4. **m2 設定の検証**
   - `src/core/limits.ts` に、名前を付けた倍数の定数を置く（例: `INTERACTION_TIMEOUT_COUNT_PER_CANDIDATE = 2`）。
   - `page-auditor.ts` の同じ定数は消し、`limits.ts` から使う。
   - `audit.interactions` が有効な場合は、`overallPageTimeoutMs >= navigationTimeoutMs + 倍数 × interactionTimeoutMs` を検証する。満たさない設定は、エラーにする。
   - 既定の設定が通ることと、満たさない設定が拒まれることを、テストで確かめる。
   - `src/core/limits.ts` の `INTERACTION_CLEANUP_ALLOWANCE_MS` のコメントを、設計書 4.5.7 の現行の説明に合わせて直す。
5. **m4 テストの質**
   - Page Auditor のテストで、すべての監査の後に、ブラウザに残っている Context が0個であることを確かめる。`afterEach` で黙って閉じるだけにしない。
   - `page-auditor.test.ts:286` 付近の `every` は、0件でも真になる。先に件数を確かめる形にする。
   - Page Auditor を通したテストを加える。
     - Passive で、GET 以外（POST、sendBeacon など）を送るページを監査する。
     - fixture のサーバに GET 以外が届かないことを確かめる。
     - `SAFETY_NON_READ_REQUEST_BLOCKED` の Finding ができることを確かめる。

## 受け入れ条件

- 各項目で、修正前に RED、修正後に GREEN になる。
- 既存の Page Auditor のテストは、すべて PASS する。
- `npm run typecheck` が PASS する。
- `npm run verify` が PASS する。このサブタスクでは build を実行してよい。

## 報告

共通ルールの形式で、日本語で報告してください。
