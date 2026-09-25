# R15e 指示書: R15 の指摘の修正（Ledger の登録、PREFLIGHT の違反、実行時間、最初の試行の Evidence、テスト）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。末尾の「一時ディレクトリの扱い」も守ってください。

## サブタスク

- ID: R15e
- 目的: Task 15 のチェックポイントのレビュー R15 の I1、I2、Minor-3、Minor-4、Minor-6 を直す。
- 設計書: `doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md`
  - 5.6.3（実行時間の超過の記録）
  - 5.6.4（最初の試行の Evidence の保持）
  - 5.6.5（Ledger の登録からの集計）
  - 5.6.7（PREFLIGHT の違反）
- レビューの結果: 作業記録置き場の `R15-review-result.md`
- 前の報告: `R15d-report.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

このサブタスクは単独で実行します。

## 変更してよいファイル

- `src/orchestration/run-coordinator.ts`、`src/orchestration/run-aggregation.ts`、`src/orchestration/crawl-frontier.ts`
- `src/core/status.ts`（`deriveRunStatus` の判定の順序に限る）
- `src/core/contracts.ts`、`schemas/run.schema.json`（`RunRetryRecord.evidenceIds` の追加に限る）
- テスト:
  - `tests/unit/run-coordinator.test.ts`、`tests/unit/status.test.ts`
  - `tests/integration/crawl-run.test.ts`
  - `tests/unit/schema-validator.test.ts`、`tests/unit/core-contracts.test.ts`（`evidenceIds` の追加に伴うものに限る）

## 修正する内容

1. **I2 Ledger の登録**（設計書 5.6.5）
   - Coordinator は、注入された `createSafetyLedger` を包み、作ったすべての Ledger を1か所に登録する。
   - `RunSafetySummary` の違反、記録の切り詰め、`blockedActions`、`blockedRequestsByMethod` は、この登録にあるすべての Ledger の snapshot からだけ集計する。
     - いまの、ページの `PageSafetySummary` や Evidence などから集める処理は、この集計に置き換える。
     - 同じ集計を、2か所に残さない。
   - `summarizePageSafety` など、既存の部品を使えるなら使う。
   - テストで、次のことを確かめる。修正前に RED、修正後に GREEN になること。
     - Page Auditor が、Ledger に違反を記録してから例外を投げた場合に、`ABORTED_BY_SAFETY` になる。
2. **I1 テストの追加**
   - R15 で、壊しても検出されなかった6か所を、検出できるテストを加える。
     - 環境の事実の Ledger に違反がある → `ABORTED_BY_SAFETY`
     - metadata の Ledger に違反がある → `ABORTED_BY_SAFETY`
     - 再試行の前の試行の遮断が、件数に入る
     - スキーマに合わないページがある → `REQUIRED_ARTIFACT_INVALID` の理由が付き、`COMPLETE` にならない
     - Cross-page rule の失敗 → Run の理由に入り、`COMPLETE` にならない
     - metadata を閉じる処理の失敗 → Run の理由に入る
   - どのテストも、該当する実装を一時的に壊すと失敗することを確かめる。
     - 確かめた後は、元に戻し、SHA-256 で一致を確かめる。
3. **Minor-3 PREFLIGHT の違反**（設計書 5.6.7）
   - `deriveRunStatus` で、違反の判定（`safetyInvariantViolations > 0`）を、`preflightFailed` の判定より先に行う。
   - `tests/unit/status.test.ts` の、PREFLIGHT の失敗を優先するテスト（50行目付近）を、新しい順序に合わせて直す。
     - 違反のない PREFLIGHT の失敗は、`FAILED` のままであることも確かめる。
   - Run Coordinator で、PREFLIGHT の Guard の失敗で違反が記録された場合に、`ABORTED_BY_SAFETY` になることを確かめる。
4. **Minor-4 実行時間の超過の記録**（設計書 5.6.3）
   - 最後のページで実行時間の上限を超え、監査していない URL が残らない場合は、次のようにする。
     - `crawlLimits.maxRuntimeReached` を真にする。
     - 理由は付けない（`COMPLETE` のままにできる）。
   - 監査していない URL が残る場合は、これまでどおりとする（`MAX_RUNTIME_REACHED` と `SKIPPED`）。
   - テストで、両方を確かめる。
5. **Minor-6 最初の試行の Evidence**（設計書 5.6.4）
   - `RunRetryRecord` に、`evidenceIds: readonly EvidenceId[]` を加える。型とスキーマの両方に加える。
   - 最初の試行の Evidence を、最終のページの `evidence` に残す。`evidenceIds` には、その ID を入れる。
   - 最初の試行の Finding は、残さない。
   - テストで、次のことを確かめる。
     - 再試行したページの `evidence` に、最初の試行の Evidence がある。
     - `retries[].evidenceIds` が、それを指す。
     - 結果が、スキーマに合う。

## 受け入れ条件

- 各項目で、修正前に RED、修正後に GREEN になる。
- 既存のテストは、すべて PASS する。変わってよい期待値は、上の修正の対象だけである。
- `npm run typecheck` が PASS する。
- `npm run verify` が PASS する。このサブタスクでは build を実行してよい。

## 報告

共通ルールの形式で、日本語で報告してください。
