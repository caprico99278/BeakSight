// T25c（Task 25 の設計書 `2026-10-10-beaksight-task-25-manual-login-session-design.md` 4.2、指示書の作るもの 6）: 監査の段の除外の記録
// （`blockedAuditExclusions`）は、設定どおりに止めた記録なので、Ledger を不完全（`recordLimits.truncated`）にしない（Run を PARTIAL にしない）。
// LZ-3a: Ledger の事象の数の上限（前は 256）は撤廃した。前の上限を超える除外も、残らず記録する。
import { describe, expect, it } from 'vitest';
import { BLOCKED_AUDIT_EXCLUSION_REASONS } from '../../src/core/evidence-types.js';
import { deriveRunStatus } from '../../src/core/status.js';
import { summarizeRunSafety } from '../../src/orchestration/run-aggregation.js';
import { SafetyLedger, summarizePageSafety } from '../../src/safety/safety-ledger.js';

/** 撤廃した Ledger の 1 つの種類の記録の上限（前の `MAX_LEDGER_EVENTS`）の写し。 */
const FORMER_LEDGER_EVENT_LIMIT = 256;
/** 前の上限を超えて記録する件数。 */
const OVER_LIMIT = 44;
const [AUDIT_EXCLUDED_URL] = BLOCKED_AUDIT_EXCLUSION_REASONS;

const recordExclusions = (ledger: SafetyLedger, count: number): void => {
  for (let index = 0; index < count; index += 1) {
    ledger.recordBlockedAuditExclusion({
      method: 'GET',
      url: `http://127.0.0.1:4173/admin/logout?i=${index}`,
      mainFrameNavigation: false,
      reason: AUDIT_EXCLUDED_URL,
      resourceType: 'fetch',
      phase: 'LOAD',
    });
  }
};

describe('T25c・LZ-3a: the audit exclusions beyond the former limit are all recorded', () => {
  it('counts and keeps every exclusion, and the Ledger is not truncated', () => {
    const ledger = new SafetyLedger();
    recordExclusions(ledger, FORMER_LEDGER_EVENT_LIMIT + OVER_LIMIT);
    const snapshot = ledger.snapshot();

    expect(snapshot.blockedAuditExclusions?.count).toBe(FORMER_LEDGER_EVENT_LIMIT + OVER_LIMIT);
    expect(snapshot.blockedAuditExclusions?.events).toHaveLength(FORMER_LEDGER_EVENT_LIMIT + OVER_LIMIT);
    expect(snapshot.recordLimits).toMatchObject({ truncated: false, droppedEventCount: 0, reachedCategories: [] });
    expect(summarizePageSafety([snapshot]).recordTruncated).toBe(false);
  });

  it('does not make the Run PARTIAL through the Ledger truncation input', () => {
    const ledger = new SafetyLedger();
    recordExclusions(ledger, FORMER_LEDGER_EVENT_LIMIT + OVER_LIMIT);
    const runSafety = summarizeRunSafety({ guardEnabled: true, snapshots: [ledger.snapshot()], auditSendPolicy: 'READ_ONLY' });

    expect(runSafety.recordTruncated).toBe(false);
    expect(deriveRunStatus({
      preflightFailed: false,
      safetyInvariantViolations: runSafety.invariantViolationCount,
      safetyLedgerTruncated: runSafety.recordTruncated,
      incompleteReasons: [],
      unhandledFailures: 0,
      crawlLimitReached: false,
      requiredArtifactsValid: true,
      executionComplete: true,
      skippedRequiredWork: 0,
      blockedRequiredWork: 0,
      timedOutRequiredWork: 0,
      notObservedRequiredWork: 0,
      notVerifiedRequiredWork: 0,
      failedRequiredWork: 0,
      incompleteCollectorCount: 0,
    })).toBe('COMPLETE');
  });

});
