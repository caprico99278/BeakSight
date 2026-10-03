# P14a 実装報告（要約。設計者が保存）

## 結論

完了した。指示書の9項目をすべて実装した。担当のテストは25ファイル・1005件が PASS し、`npm run typecheck` も PASS した。verify は、並行作業のため実行していない。

## P14b〜P14d で使う型と関数

- `ViewportAuditResult.navigationOutcome: NavigationOutcomeKind | null`（スキップしたビューポートでは null）
- `PAGE_AUDIT_STAGES` と、その型 `PageAuditStage`（`src/core/contracts.ts`）
- `PageSafetySummary { invariantViolationCount; invariantViolations; recordTruncated }`
- `PageAuditOutcome { result; safety }`
- `derivePageAuditStatus(viewportStatuses)`、`collectorIncompleteReason(stage, reason)`（`src/core/status.ts`）
- `BLOCKED_EXTERNAL_ACTION_REASONS`（`src/core/evidence-types.ts`）
- `summarizePageSafety(snapshots)`、`isBlockedExternalActionReason(reason)`（`src/safety/safety-ledger.ts`）
- 定数（`src/core/limits.ts`）
  - `INTERACTION_CLEANUP_ALLOWANCE_MS = 2000`
  - `PAGE_SETTLING_PACING = { pollIntervalMs: 100, stableWindowMs: 500 }`
  - `CONTROLLED_SCROLL_PACING = { stepViewportFraction: 0.75, stepWaitMs: 250, stableWindowMs: 500 }`
  - `SCROLL_STAGE_BUDGET_SETTLING_MULTIPLIER = 4`
- `IdAllocator`（`src/orchestration/id-allocator.ts`）
  - 次の4つの操作を持つ。
    - `allocatePageId()`
    - `allocateEvidenceId(type)`（Run で1つの連番）
    - `nextFindingSequence` の取得
    - `advanceFindingSequence(n)`（連番を戻す値は拒否する）
- 時間の設定4つを、正の整数に限った。設定の検証と run のスキーマの両方で行う。
- `CrossPageViewportResult` を、`ViewportAuditResult` の別名にした。`isLinkTargetVerified` は、`navigationOutcome !== null` で判断する。
- CC-014: `BlockedExternalActionEvent.reason` を、閉じた型にした。記録する本番のコードは、`isolated-auditor.ts` の1か所だけである。

## 実装者の判断と、設計者の判断

1. 一部のビューポートだけが SKIPPED の場合は、ページを PARTIAL にする。すべてが SKIPPED の場合は、ページも SKIPPED にする。→ 承認する。
   - 監査していない部分があるページを、完了と報告しないためである。
   - 設計書 4.2 に書き加えた。
2. `PageSafetySummary` に、`invariantViolations`（記録できた違反の一覧）を加えた。→ 承認する。
   - run.json の `RunSafetySummary.invariantViolations` を作る材料になる。
   - Run 全体での件数の上限は、Task 15 で決める。
3. `isBlockedExternalActionReason` を、`safety-ledger.ts` に置いた。→ 承認する。
4. スキーマの見本の、矛盾した値を直した。→ 承認する。
5. 後片付けの実際の上限は、`INTERACTION_CLEANUP_ALLOWANCE_MS` ではない。`auditInteraction` の中で、`interactionTimeoutMs` を使って決まる。→ 設計書 4.5.7 を直す。
   - P14d では、候補ごとに見積もる時間を、次の3つの和にする。
     - `navigationTimeoutMs`
     - `interactionTimeoutMs`（操作）
     - `interactionTimeoutMs`（後片付けの上限）
   - `INTERACTION_CLEANUP_ALLOWANCE_MS` は、`InteractionOwnerCleanupError` のときに、Page Auditor が `close()` を試みる時間の上限として使う。
6. 共通部品台帳が、まだ更新されていない。→ 設計者が更新した。
