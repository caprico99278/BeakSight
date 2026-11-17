// SAFE-2 の 4（違反の区分の (3)。設計者の判断）: 正しく止めて記録できた 3 つを、違反でなく記録にする。
// - frame の判定の失敗: `frameClassificationFailures`（`{ url, phase }`）。
// - GET・HEAD の main frame の配送の失敗: 読み取りの失敗の記録 `readNavigationFailures`（`{ method, url（Origin と path）, errorText, phase }`）。
// - 外部スキームの frame の分かる移動: 既存の `externalSchemeNavigations`（違反と Context を閉じることだけを外す。Guard の側）。
// 記録は 1 件でもあるときだけ snapshot と safety の Evidence に現れる（`count` と `events`）。`summarizePageSafety` は数を持つ。発見の probe の続け方は、
// 違反でなく記録から決める（`probeRecordContinuationOf`）。
import { describe, expect, it } from 'vitest';
import { probeRecordContinuationOf } from '../../src/safety/job-safety-violation.js';
import { SafetyLedger, safetyEventsEvidenceFromSnapshot, summarizePageSafety } from '../../src/safety/safety-ledger.js';

describe('the records that replace the violations of category (3)', () => {
  it('records the frame classification failures and the read navigation failures without a violation', () => {
    const ledger = new SafetyLedger();
    ledger.recordFrameClassificationFailure({ url: 'tel:+10000000000', phase: 'INTERACTION' });
    ledger.recordReadNavigationFailure({
      method: 'GET',
      url: 'https://example.test/list/items?token=secret#top',
      errorText: 'net::ERR_ABORTED',
      phase: 'INTERACTION',
    });

    const snapshot = ledger.snapshot();
    expect(snapshot.invariantViolations).toEqual([]);
    expect(snapshot.invariantViolationCount).toBe(0);
    expect(snapshot.frameClassificationFailures).toEqual({ count: 1, events: [{ url: 'tel:+10000000000', phase: 'INTERACTION' }] });
    expect(snapshot.readNavigationFailures).toEqual({
      count: 1,
      events: [{ method: 'GET', url: 'https://example.test/list/items', errorText: 'net::ERR_ABORTED', phase: 'INTERACTION' }],
    });
    const evidence = safetyEventsEvidenceFromSnapshot(snapshot, 'PASSIVE', { kind: 'PAGE_AUDIT' });
    expect(evidence.frameClassificationFailures?.count).toBe(1);
    expect(evidence.readNavigationFailures?.count).toBe(1);
  });

  it('leaves the records out of the snapshot when nothing was recorded', () => {
    const snapshot = new SafetyLedger().snapshot();
    expect(Object.hasOwn(snapshot, 'frameClassificationFailures')).toBe(false);
    expect(Object.hasOwn(snapshot, 'readNavigationFailures')).toBe(false);
  });

  it('counts the records in the page safety summary', () => {
    const first = new SafetyLedger();
    first.recordFrameClassificationFailure({ url: 'mailto:someone@example.test', phase: 'PASSIVE' });
    const second = new SafetyLedger();
    second.recordReadNavigationFailure({ method: 'HEAD', url: 'https://example.test/a', errorText: 'net::ERR_ABORTED', phase: 'PASSIVE' });
    second.recordReadNavigationFailure({ method: 'GET', url: 'https://example.test/b', errorText: 'net::ERR_ABORTED', phase: 'PASSIVE' });

    const summary = summarizePageSafety([first.snapshot(), second.snapshot()]);
    expect(summary).toMatchObject({ invariantViolationCount: 0, frameClassificationFailureCount: 1, readNavigationFailureCount: 2 });
  });

  it('decides how the discovery continues after a press from the records, not from violations', () => {
    const external = new SafetyLedger();
    external.recordExternalSchemeNavigation({ url: 'tel:+1', scheme: 'tel', frame: 'MAIN', phase: 'INTERACTION', reason: 'EXTERNAL_SCHEME_NAVIGATION' });
    expect(probeRecordContinuationOf(external.snapshot())).toBe('EXTERNAL_SCHEME');

    const popup = new SafetyLedger();
    popup.recordFrameClassificationFailure({ url: 'tel:+1', phase: 'INTERACTION' });
    expect(probeRecordContinuationOf(popup.snapshot())).toBe('EXTERNAL_SCHEME');

    const canceled = new SafetyLedger();
    canceled.recordReadNavigationFailure({ method: 'GET', url: 'https://example.test/next', errorText: 'net::ERR_ABORTED', phase: 'INTERACTION' });
    expect(probeRecordContinuationOf(canceled.snapshot())).toBe('READ_NAVIGATION_CANCELED');

    // 凍結の前（読み込みの間）の記録と、止めたリダイレクトは、押下の続け方に使わない。
    const before = new SafetyLedger();
    before.recordReadNavigationFailure({ method: 'GET', url: 'https://example.test/next', errorText: 'net::ERR_ABORTED', phase: 'PASSIVE' });
    before.recordExternalSchemeNavigation({ url: 'tel:+1', scheme: 'tel', frame: 'SUB', phase: 'INTERACTION', reason: 'EXTERNAL_SCHEME_REDIRECT_BLOCKED' });
    expect(probeRecordContinuationOf(before.snapshot())).toBeNull();
    expect(probeRecordContinuationOf(new SafetyLedger().snapshot())).toBeNull();
  });
});
