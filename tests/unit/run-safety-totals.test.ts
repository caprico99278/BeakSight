// MEM-3c（DEF-266。D7）: 再開のときは、保存のページの Safety Ledger の snapshot を全部持たずに、読んだ順に足し込む（`RunSafetyTotals`）。Run の Safety の要約は、
// snapshot を全部並べて `summarizeRunSafety` に渡したときと同じになる。
import { describe, expect, it } from 'vitest';
import { RunSafetyTotals, summarizeRunSafety } from '../../src/orchestration/run-aggregation.js';
import { SafetyLedger, type SafetyLedgerSnapshot } from '../../src/safety/safety-ledger.js';

const ORIGIN = 'http://127.0.0.1:4173';

/** 遮断・違反・通した送信を持つ snapshot（`seed` ごとに違う数）。 */
const snapshotOf = (seed: number): SafetyLedgerSnapshot => {
  const ledger = new SafetyLedger();
  for (let index = 0; index < seed; index += 1) {
    ledger.recordBlockedRequest({ method: index % 2 === 0 ? 'POST' : 'DELETE', url: `${ORIGIN}/api/${String(index)}`, reason: 'NON_READ_METHOD', resourceType: 'fetch', phase: 'LOAD' });
    ledger.recordPassedAuditSendRequest({ method: index % 2 === 0 ? 'PUT' : 'post', url: `${ORIGIN}/api/save` });
  }
  if (seed % 3 === 0) {
    ledger.recordInvariantViolation({ code: 'FRAME_CLASSIFICATION_FAILED', message: `violation ${String(seed)}` });
  }
  ledger.recordPassedAuditSendWebSocket({ url: `wss://127.0.0.1:4173/ws/${String(seed)}`, outsideGuard: seed % 2 === 0, dangerous: false });
  return ledger.snapshot();
};

describe('MEM-3c: the Safety totals of the resumed Run (D7)', () => {
  it('gives the same Run Safety summary as summarizeRunSafety over all the snapshots in the same order', () => {
    const stateSnapshots = [snapshotOf(1), snapshotOf(2)];
    const pageSnapshots = [snapshotOf(3), snapshotOf(4), snapshotOf(0), snapshotOf(6)];
    const currentSnapshots = [snapshotOf(5)];
    const input = { guardEnabled: true, auditSendPolicy: 'PASS_EXCEPT_DELETE' as const };

    const pages = new RunSafetyTotals();
    for (const snapshot of pageSnapshots) {
      pages.add(snapshot);
    }
    const saved = new RunSafetyTotals();
    for (const snapshot of stateSnapshots) {
      saved.add(snapshot);
    }
    saved.addTotals(pages);

    const expected = summarizeRunSafety({ ...input, snapshots: [...stateSnapshots, ...pageSnapshots, ...currentSnapshots] });
    expect(saved.summary(input, currentSnapshots)).toEqual(expected);
    expect(expected.invariantViolationCount).toBeGreaterThan(0);
    expect(saved.hasInvariantViolation).toBe(true);
    expect(new RunSafetyTotals().add(snapshotOf(1)).hasInvariantViolation).toBe(false);
    // 足し込みは、すでに足したものを変えずに、追加の snapshot を受け取る（2 回呼んでも同じ）。
    expect(saved.summary(input, currentSnapshots)).toEqual(expected);
  });
});
