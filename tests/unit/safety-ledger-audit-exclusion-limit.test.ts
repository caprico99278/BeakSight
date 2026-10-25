// T25c（Task 25 の設計書 `2026-10-10-beaksight-task-25-manual-login-session-design.md` 4.2、指示書の作るもの 6）: 監査の段の除外の記録
// （`blockedAuditExclusions`）は、設定どおりに止めた記録なので、その記録だけが上限を超えても、Ledger を不完全（`recordLimits.truncated`）に
// しない（Run を PARTIAL にしない）。件数（`count`）は上限を超えた分も正しく数え、記録しなかった件数（`droppedEventCount`）と、上限に達した
// 分類（`reachedCategories`）は、事実として残す。ほかの種類の記録の上限の扱いは変えない。
import { describe, expect, it } from 'vitest';
import { BLOCKED_AUDIT_EXCLUSION_REASONS } from '../../src/core/evidence-types.js';
import { deriveRunStatus } from '../../src/core/status.js';
import { summarizeRunSafety } from '../../src/orchestration/run-aggregation.js';
import { SafetyLedger, summarizePageSafety } from '../../src/safety/safety-ledger.js';

/** Ledger の 1 つの種類の記録の上限（`safety-ledger.ts` の `MAX_LEDGER_EVENTS`）。 */
const LEDGER_EVENT_LIMIT = 256;
/** 上限を超えて記録する件数。 */
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

describe('T25c: the audit exclusion record limit does not make the Ledger truncated', () => {
  it('counts every exclusion, keeps the first 256 events, and is not truncated when only the exclusion record overflows', () => {
    const ledger = new SafetyLedger();
    recordExclusions(ledger, LEDGER_EVENT_LIMIT + OVER_LIMIT);
    const snapshot = ledger.snapshot();

    expect(snapshot.blockedAuditExclusions?.count).toBe(LEDGER_EVENT_LIMIT + OVER_LIMIT);
    expect(snapshot.blockedAuditExclusions?.events).toHaveLength(LEDGER_EVENT_LIMIT);
    expect(snapshot.recordLimits.truncated).toBe(false);
    expect(snapshot.recordLimits.droppedEventCount).toBe(OVER_LIMIT);
    expect(snapshot.recordLimits.reachedCategories).toEqual(['blockedAuditExclusions']);
    expect(summarizePageSafety([snapshot]).recordTruncated).toBe(false);
  });

  it('does not make the Run PARTIAL through the Ledger truncation input', () => {
    const ledger = new SafetyLedger();
    recordExclusions(ledger, LEDGER_EVENT_LIMIT + OVER_LIMIT);
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

  it('keeps the truncation of the other records (another record over its limit still truncates the Ledger)', () => {
    const ledger = new SafetyLedger();
    recordExclusions(ledger, LEDGER_EVENT_LIMIT + OVER_LIMIT);
    for (let index = 0; index <= LEDGER_EVENT_LIMIT; index += 1) {
      ledger.recordBlockedWebSocket({ url: `ws://127.0.0.1:4173/ws?i=${index}`, reason: 'PASSIVE_WEBSOCKET', phase: 'LOAD' });
    }
    const snapshot = ledger.snapshot();

    expect(snapshot.recordLimits.truncated).toBe(true);
    expect(snapshot.recordLimits.droppedEventCount).toBe(OVER_LIMIT + 1);
    expect(snapshot.recordLimits.reachedCategories).toEqual(['blockedAuditExclusions', 'blockedWebSockets']);
  });

  it('keeps the exact limit without a drop (256 exclusions are all recorded)', () => {
    const ledger = new SafetyLedger();
    recordExclusions(ledger, LEDGER_EVENT_LIMIT);
    const snapshot = ledger.snapshot();

    expect(snapshot.blockedAuditExclusions?.count).toBe(LEDGER_EVENT_LIMIT);
    expect(snapshot.recordLimits).toMatchObject({ truncated: false, droppedEventCount: 0, reachedCategories: [] });
  });
});
