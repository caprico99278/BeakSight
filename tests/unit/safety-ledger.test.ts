import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  EvidencePayloadByType,
  PageSafetySummary,
  RunSafetySummary,
  SafetyInvariantViolationSummary,
} from '../../src/core/contracts.js';
import {
  BLOCKED_EXTERNAL_ACTION_REASONS,
  INTERACTION_REJECTION_REASONS,
  type BlockedExternalActionReason,
  type InteractionRejectionReasonEvidence,
  type SafetyEventKind,
  type SafetyEventsEvidence,
  type SafetyEvidenceScope,
  type SafetyLedgerRecordLimits,
} from '../../src/core/evidence-types.js';
import { deriveRunStatus } from '../../src/core/status.js';
import { interactionRejectionLedgerRecord } from '../../src/safety/interaction-policy.js';
import {
  SafetyLedger,
  isBlockedExternalActionReason,
  safetyEventsEvidenceFromSnapshot,
  summarizePageSafety,
  type InvariantViolationEvent,
  type SafetyLedgerReachedCategory,
  type SafetyLedgerRecordCategory,
  type SafetyLedgerSnapshot,
  type SafetyLedgerUncountedBlockedRequestCategory,
} from '../../src/safety/safety-ledger.js';
import { runStatusInput } from '../helpers/audit-run-fixture.js';

/** 実行はすべて完了し、安全の事実だけを Ledger から渡したときの Run Status。 */
const runStatusFromLedger = (snapshot: SafetyLedgerSnapshot) => deriveRunStatus(runStatusInput({
  safetyInvariantViolations: snapshot.invariantViolationCount,
  safetyLedgerTruncated: snapshot.recordLimits.truncated,
}));

describe('SafetyLedger', () => {
  it('keeps blocked events distinct from invariant violations and counts request methods canonically', () => {
    const ledger = new SafetyLedger();
    ledger.recordBlockedRequest({ method: 'post', url: 'https://example.test/submit', reason: 'NON_READ_METHOD' });
    ledger.recordBlockedNavigation({ method: 'GET', url: 'https://external.test/', reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION' });
    ledger.recordBlockedWebSocket({ url: 'wss://example.test/socket', reason: 'PASSIVE_WEBSOCKET' });

    expect(ledger.snapshot()).toMatchObject({
      blockedRequestsByMethod: { POST: 1 },
      blockedRequests: [{ method: 'POST', url: 'https://example.test/submit', reason: 'NON_READ_METHOD' }],
      blockedNavigations: [{
        method: 'GET',
        url: 'https://external.test/',
        reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION',
      }],
      blockedWebSockets: [{ url: 'wss://example.test/socket', reason: 'PASSIVE_WEBSOCKET' }],
      invariantViolations: [],
    });
  });

  it('returns deeply immutable copies that cannot alter later snapshots', () => {
    const ledger = new SafetyLedger();
    const event = { method: 'PATCH', url: 'https://example.test/mutate', reason: 'NON_READ_METHOD' as const };
    ledger.recordBlockedRequest(event);

    const first = ledger.snapshot();
    event.url = 'https://attacker.test/changed-after-recording';

    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.blockedRequestsByMethod)).toBe(true);
    expect(Object.isFrozen(first.blockedRequests)).toBe(true);
    expect(Object.isFrozen(first.blockedRequests[0])).toBe(true);
    expect(() => {
      (first.blockedRequestsByMethod as Record<string, number>).PATCH = 99;
    }).toThrow();
    expect(ledger.snapshot()).not.toBe(first);
    expect(ledger.snapshot().blockedRequests[0]?.url).toBe('https://example.test/mutate');
    expect(ledger.snapshot().blockedRequestsByMethod.PATCH).toBe(1);
  });

  it('records an actual invariant violation separately', () => {
    const ledger = new SafetyLedger();

    ledger.recordInvariantViolation({ code: 'FRAME_CLASSIFICATION_FAILED', message: 'frame unavailable' });

    expect(ledger.snapshot().invariantViolations).toEqual([
      { code: 'FRAME_CLASSIFICATION_FAILED', message: 'frame unavailable' },
    ]);
    expect(ledger.snapshot().blockedRequests).toEqual([]);
  });

  it('counts an unknown method without colliding with object prototype names', () => {
    const ledger = new SafetyLedger();

    ledger.recordBlockedRequest({
      method: '__proto__',
      url: 'https://example.test/unknown-method',
      reason: 'NON_READ_METHOD',
    });

    expect(ledger.snapshot().blockedRequestsByMethod.__PROTO__).toBe(1);
    expect(Object.getPrototypeOf(ledger.snapshot().blockedRequestsByMethod)).toBeNull();
  });

  it('bounds and deeply freezes interaction safety events', () => {
    const ledger = new SafetyLedger();
    for (let index = 0; index < 300; index += 1) {
      ledger.recordBlockedInteractionRequest({
        method: 'get',
        url: `https://example.test/${index}`,
        reason: 'INTERACTION_FROZEN',
      });
    }

    const snapshot = ledger.snapshot();
    expect(snapshot.blockedInteractionRequests).toHaveLength(256);
    expect(snapshot.invariantViolations).toEqual([]);
    expect(snapshot.invariantViolationCount).toBe(0);
    expect(snapshot.recordLimits).toMatchObject({
      truncated: true,
      droppedEventCount: 44,
      reachedCategories: ['blockedInteractionRequests'],
    });
    expect(Object.isFrozen(snapshot.blockedInteractionRequests)).toBe(true);
    expect(Object.isFrozen(snapshot.blockedInteractionRequests[0])).toBe(true);
    expect(() => {
      (snapshot.blockedInteractionRequests as unknown as { method: string }[])[0]!.method = 'POST';
    }).toThrow();
  });

  it('bounds every Task 5 event category and every retained string', () => {
    const ledger = new SafetyLedger();
    const longText = 'x'.repeat(3_000);
    for (let index = 0; index < 300; index += 1) {
      ledger.recordBlockedRequest({ method: longText, url: longText, reason: 'NON_READ_METHOD' });
      ledger.recordBlockedNavigation({ method: longText, url: longText, reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION' });
      ledger.recordBlockedWebSocket({ url: longText, reason: 'PASSIVE_WEBSOCKET' });
      ledger.recordInvariantViolation({ code: longText, message: longText });
    }

    const snapshot = ledger.snapshot();
    expect(snapshot.blockedRequests).toHaveLength(256);
    expect(snapshot.blockedNavigations).toHaveLength(256);
    expect(snapshot.blockedWebSockets).toHaveLength(256);
    expect(snapshot.invariantViolations).toHaveLength(256);
    expect(snapshot.invariantViolationCount).toBe(300);
    expect(snapshot.blockedRequests[0]?.method).toHaveLength(32);
    expect(snapshot.blockedRequests[0]?.url).toHaveLength(2_048);
    expect(snapshot.blockedNavigations[0]?.method).toHaveLength(32);
    expect(snapshot.blockedNavigations[0]?.url).toHaveLength(2_048);
    expect(snapshot.blockedWebSockets[0]?.url).toHaveLength(2_048);
    expect(snapshot.invariantViolations.every((event) => (
      event.code.length <= 2_048 && event.message.length <= 2_048
    ))).toBe(true);
    expect(snapshot.invariantViolations.every((event) => event.code === 'x'.repeat(2_048))).toBe(true);
    expect(snapshot.recordLimits.truncated).toBe(true);
    expect(snapshot.recordLimits.droppedEventCount).toBe(4 * 44);
    expect(snapshot.recordLimits.reachedCategories).toEqual(expect.arrayContaining([
      'blockedRequests',
      'blockedNavigations',
      'blockedWebSockets',
      'invariantViolations',
    ]));
    expect(snapshot.recordLimits.truncatedTextCount).toBeGreaterThan(0);
    expect(Object.isFrozen(snapshot.recordLimits)).toBe(true);
    expect(Object.isFrozen(snapshot.recordLimits.reachedCategories)).toBe(true);
    expect(Object.isFrozen(snapshot.blockedNavigations)).toBe(true);
    expect(Object.isFrozen(snapshot.blockedWebSockets[0])).toBe(true);
  });

  it('caps distinct bounded method keys and records the overflow once', () => {
    const ledger = new SafetyLedger();
    for (let index = 0; index < 80; index += 1) {
      ledger.recordBlockedRequest({
        method: `custom-method-${index}`,
        url: `https://example.test/${index}`,
        reason: 'NON_READ_METHOD',
      });
    }

    const snapshot = ledger.snapshot();
    expect(Object.keys(snapshot.blockedRequestsByMethod)).toHaveLength(64);
    expect(Object.keys(snapshot.blockedRequestsByMethod).every((method) => method.length <= 32)).toBe(true);
    expect(snapshot.invariantViolations).toEqual([]);
    expect(snapshot.recordLimits.truncated).toBe(true);
    expect(snapshot.recordLimits.uncountedBlockedRequestCount).toBe(16);
    expect(snapshot.recordLimits.reachedCategories.filter(
      (category) => category === 'blockedRequestsByMethod',
    )).toHaveLength(1);
  });

  it('saturates a method counter and records the saturation once', () => {
    const ledger = new SafetyLedger();
    for (let index = 0; index < 65_540; index += 1) {
      ledger.recordBlockedRequest({ method: 'POST', url: 'https://example.test/', reason: 'NON_READ_METHOD' });
    }

    const snapshot = ledger.snapshot();
    expect(snapshot.blockedRequestsByMethod.POST).toBe(65_535);
    expect(snapshot.invariantViolations).toEqual([]);
    expect(snapshot.recordLimits.truncated).toBe(true);
    expect(snapshot.recordLimits.uncountedBlockedRequestCount).toBe(5);
    expect(snapshot.recordLimits.reachedCategories.filter(
      (category) => category === 'blockedRequestsByMethod.POST.counter',
    )).toHaveLength(1);
  });

  describe('R3: the record limit is an incomplete record, not an invariant violation', () => {
    it('keeps 257 blocked POST requests out of invariantViolations and derives PARTIAL', () => {
      const ledger = new SafetyLedger();
      for (let index = 0; index < 257; index += 1) {
        ledger.recordBlockedRequest({ method: 'POST', url: `https://example.test/${index}`, reason: 'NON_READ_METHOD' });
      }

      const snapshot = ledger.snapshot();
      expect(snapshot.blockedRequests).toHaveLength(256);
      expect(snapshot.blockedRequestsByMethod.POST).toBe(257);
      expect(snapshot.invariantViolations).toEqual([]);
      expect(snapshot.invariantViolationCount).toBe(0);
      expect(snapshot.recordLimits).toEqual({
        truncated: true,
        droppedEventCount: 1,
        uncountedBlockedRequestCount: 0,
        truncatedTextCount: 0,
        reachedCategories: ['blockedRequests'],
      });
      expect(runStatusFromLedger(snapshot)).toBe('PARTIAL');
    });

    it('reports a complete record at exactly the event limit', () => {
      const ledger = new SafetyLedger();
      for (let index = 0; index < 256; index += 1) {
        ledger.recordBlockedRequest({ method: 'POST', url: `https://example.test/${index}`, reason: 'NON_READ_METHOD' });
      }

      expect(ledger.snapshot().recordLimits).toEqual({
        truncated: false,
        droppedEventCount: 0,
        uncountedBlockedRequestCount: 0,
        truncatedTextCount: 0,
        reachedCategories: [],
      });
      expect(runStatusFromLedger(ledger.snapshot())).toBe('COMPLETE');
    });

    it('never overwrites a real invariant violation when other records are full', () => {
      const ledger = new SafetyLedger();
      ledger.recordInvariantViolation({ code: 'HTTP_ABORT_FAILED', message: 'abort failed' });
      for (let index = 0; index < 300; index += 1) {
        ledger.recordBlockedRequest({ method: `M${index}`, url: 'https://example.test/', reason: 'NON_READ_METHOD' });
        ledger.recordBlockedDownload({
          url: 'https://example.test/file',
          suggestedFilename: 'file',
          reason: 'INTERACTION_FROZEN',
        });
      }

      const snapshot = ledger.snapshot();
      expect(snapshot.invariantViolations).toEqual([{ code: 'HTTP_ABORT_FAILED', message: 'abort failed' }]);
      expect(snapshot.invariantViolationCount).toBe(1);
      expect(snapshot.recordLimits.truncated).toBe(true);
      expect(runStatusFromLedger(snapshot)).toBe('ABORTED_BY_SAFETY');
    });

    it('keeps the earliest violations under their own limit and keeps counting beyond it', () => {
      const ledger = new SafetyLedger();
      for (let index = 0; index < 300; index += 1) {
        ledger.recordInvariantViolation({ code: 'GUARD_FAILURE', message: `violation ${index}` });
        ledger.recordBlockedRequest({ method: 'POST', url: 'https://example.test/', reason: 'NON_READ_METHOD' });
      }

      const snapshot = ledger.snapshot();
      expect(snapshot.invariantViolations).toHaveLength(256);
      expect(snapshot.invariantViolations.map((event) => event.message)).toEqual(
        Array.from({ length: 256 }, (_unused, index) => `violation ${index}`),
      );
      expect(snapshot.invariantViolationCount).toBe(300);
      expect(snapshot.recordLimits.truncated).toBe(true);
      expect(snapshot.recordLimits.reachedCategories).toEqual(
        expect.arrayContaining(['invariantViolations', 'blockedRequests']),
      );
      expect(runStatusFromLedger(snapshot)).toBe('ABORTED_BY_SAFETY');
    });

    it('truncates an over-long HTTP method instead of recording an invariant violation', () => {
      const ledger = new SafetyLedger();
      const method = 'X'.repeat(33);

      ledger.recordBlockedRequest({ method, url: 'https://example.test/', reason: 'NON_READ_METHOD' });
      ledger.recordBlockedNavigation({ method, url: 'https://external.test/', reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION' });
      ledger.recordBlockedInteractionRequest({ method, url: 'https://example.test/', reason: 'INTERACTION_FROZEN' });

      const snapshot = ledger.snapshot();
      expect(snapshot.invariantViolations).toEqual([]);
      expect(snapshot.invariantViolationCount).toBe(0);
      expect(snapshot.blockedRequests[0]?.method).toBe('X'.repeat(32));
      expect(snapshot.blockedRequestsByMethod['X'.repeat(32)]).toBe(1);
      expect(snapshot.blockedNavigations[0]?.method).toBe('X'.repeat(32));
      expect(snapshot.blockedInteractionRequests[0]?.method).toBe('X'.repeat(32));
      expect(snapshot.recordLimits).toMatchObject({ truncated: false, truncatedTextCount: 3 });
      expect(runStatusFromLedger(snapshot)).toBe('COMPLETE');
    });
  });
  describe('M2: mechanically excluded interaction candidates', () => {
    const candidateId = 'interaction-candidate:sha256:' + 'a'.repeat(64);

    it('records an excluded candidate separately from blocked external actions and violations', () => {
      const ledger = new SafetyLedger();

      ledger.recordExcludedInteractionCandidate({ candidateId, reason: 'SUBMISSION_CONTROL' });
      ledger.recordExcludedInteractionCandidate({ candidateId, reason: 'NAVIGATION_HREF' });

      const snapshot = ledger.snapshot();
      expect(snapshot.excludedInteractionCandidates).toEqual([
        { candidateId, reason: 'SUBMISSION_CONTROL' },
        { candidateId, reason: 'NAVIGATION_HREF' },
      ]);
      expect(snapshot.blockedExternalActions).toEqual([]);
      expect(snapshot.invariantViolations).toEqual([]);
      expect(Object.isFrozen(snapshot.excludedInteractionCandidates)).toBe(true);
      expect(Object.isFrozen(snapshot.excludedInteractionCandidates[0])).toBe(true);
      expect(runStatusFromLedger(snapshot)).toBe('COMPLETE');
    });

    it('bounds the candidate ID and marks the record incomplete at the event limit', () => {
      const ledger = new SafetyLedger();
      ledger.recordExcludedInteractionCandidate({ candidateId: 'x'.repeat(3_000), reason: 'RESET_CONTROL' });
      for (let index = 0; index < 256; index += 1) {
        ledger.recordExcludedInteractionCandidate({ candidateId, reason: 'FORM_ASSOCIATED' });
      }

      const snapshot = ledger.snapshot();
      expect(snapshot.excludedInteractionCandidates).toHaveLength(256);
      expect(snapshot.excludedInteractionCandidates[0]?.candidateId).toHaveLength(2_048);
      expect(snapshot.recordLimits).toEqual({
        truncated: true,
        droppedEventCount: 1,
        uncountedBlockedRequestCount: 0,
        truncatedTextCount: 1,
        reachedCategories: ['excludedInteractionCandidates'],
      });
      expect(runStatusFromLedger(snapshot)).toBe('PARTIAL');
    });
  });

  // C18a（DEF-012。Task 19 の前の整理の設計書 4.2）: ページのスクリプトによる外部スキームへの移動の試み。
  describe('C18a: external scheme navigations', () => {
    it('records the URL, the scheme, the frame kind and the phase, separately from violations', () => {
      const ledger = new SafetyLedger();

      ledger.recordExternalSchemeNavigation({
        url: 'mailto:nobody@example.invalid',
        scheme: 'mailto',
        frame: 'MAIN',
        phase: 'PASSIVE',
        reason: 'EXTERNAL_SCHEME_NAVIGATION',
      });
      ledger.recordExternalSchemeNavigation({
        url: 'beaksight-test-app:probe',
        scheme: 'beaksight-test-app',
        frame: 'SUB',
        phase: 'INTERACTION',
        reason: 'EXTERNAL_SCHEME_NAVIGATION',
      });

      const snapshot = ledger.snapshot();
      expect(snapshot.externalSchemeNavigations).toEqual([
        { url: 'mailto:nobody@example.invalid', scheme: 'mailto', frame: 'MAIN', phase: 'PASSIVE', reason: 'EXTERNAL_SCHEME_NAVIGATION' },
        {
          url: 'beaksight-test-app:probe',
          scheme: 'beaksight-test-app',
          frame: 'SUB',
          phase: 'INTERACTION',
          reason: 'EXTERNAL_SCHEME_NAVIGATION',
        },
      ]);
      expect(snapshot.invariantViolations).toEqual([]);
      expect(Object.isFrozen(snapshot.externalSchemeNavigations)).toBe(true);
      expect(Object.isFrozen(snapshot.externalSchemeNavigations[0])).toBe(true);
      expect(runStatusFromLedger(snapshot)).toBe('COMPLETE');
    });

    // C18g: Guard がたどる前に止めたサーバのリダイレクトは、同じ一覧に、理由を分けて記録する。違反ではない。
    it('keeps the reason of a stopped server redirect (EXTERNAL_SCHEME_REDIRECT_BLOCKED) apart from a scripted attempt', () => {
      const ledger = new SafetyLedger();

      ledger.recordExternalSchemeNavigation({
        url: 'tel:+10000000000',
        scheme: 'tel',
        frame: 'SUB',
        phase: 'PASSIVE',
        reason: 'EXTERNAL_SCHEME_REDIRECT_BLOCKED',
      });

      const snapshot = ledger.snapshot();
      expect(snapshot.externalSchemeNavigations).toEqual([
        { url: 'tel:+10000000000', scheme: 'tel', frame: 'SUB', phase: 'PASSIVE', reason: 'EXTERNAL_SCHEME_REDIRECT_BLOCKED' },
      ]);
      expect(snapshot.invariantViolations).toEqual([]);
      expect(runStatusFromLedger(snapshot)).toBe('COMPLETE');
    });

    it('redacts the credentials of the URL with the shared URL redaction rule', () => {
      const ledger = new SafetyLedger();

      ledger.recordExternalSchemeNavigation({
        url: 'beaksight-test-app://user:secret@probe/path',
        scheme: 'beaksight-test-app',
        frame: 'MAIN',
        phase: 'PASSIVE',
        reason: 'EXTERNAL_SCHEME_NAVIGATION',
      });

      const [event] = ledger.snapshot().externalSchemeNavigations;
      expect(event?.url).toBe('beaksight-test-app://[REDACTED]@probe/path');
      expect(event?.url).not.toContain('secret');
    });

    it('bounds the URL and the scheme and marks the record incomplete at the event limit', () => {
      const ledger = new SafetyLedger();
      ledger.recordExternalSchemeNavigation({
        url: `beaksight-test-app:${'x'.repeat(3_000)}`,
        scheme: 's'.repeat(3_000),
        frame: 'MAIN',
        phase: 'PASSIVE',
        reason: 'EXTERNAL_SCHEME_NAVIGATION',
      });
      for (let index = 0; index < 256; index += 1) {
        ledger.recordExternalSchemeNavigation({
          url: `tel:+1000000${index}`,
          scheme: 'tel',
          frame: 'MAIN',
          phase: 'INTERACTION',
          reason: 'EXTERNAL_SCHEME_NAVIGATION',
        });
      }

      const snapshot = ledger.snapshot();
      expect(snapshot.externalSchemeNavigations).toHaveLength(256);
      expect(snapshot.externalSchemeNavigations[0]?.url).toHaveLength(2_048);
      expect(snapshot.externalSchemeNavigations[0]?.scheme).toHaveLength(2_048);
      expect(snapshot.recordLimits).toEqual({
        truncated: true,
        droppedEventCount: 1,
        uncountedBlockedRequestCount: 0,
        truncatedTextCount: 2,
        reachedCategories: ['externalSchemeNavigations'],
      });
      expect(snapshot.invariantViolations).toEqual([]);
      expect(runStatusFromLedger(snapshot)).toBe('PARTIAL');
    });
  });
});

// T12d0（Task 12・13 の設計書 5.4.1）: Safety Ledger の snapshot から、Evidence の種類 `safety` の中身を作る。
// 不変条件の違反は Finding にせず Run Status で扱うので、Evidence には含めない。
describe('T12d0: safety Evidence from a Safety Ledger snapshot', () => {
  const candidateId = 'interaction-candidate:sha256:' + 'b'.repeat(64);

  /** すべての種類の事象と、不変条件の違反と、記録の上限の到達を持つ Ledger。 */
  function ledgerWithEveryRecord(): SafetyLedger {
    const ledger = new SafetyLedger();
    ledger.recordBlockedRequest({ method: 'post', url: 'https://example.test/submit', reason: 'NON_READ_METHOD' });
    ledger.recordBlockedNavigation({ method: 'GET', url: 'https://external.test/', reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION' });
    ledger.recordBlockedWebSocket({ url: 'wss://example.test/socket', reason: 'PASSIVE_WEBSOCKET' });
    ledger.recordBlockedExternalAction({ candidateId, url: 'tel:0000', reason: 'EXTERNAL_ACTION' });
    ledger.recordExcludedInteractionCandidate({ candidateId, reason: 'SUBMISSION_CONTROL' });
    ledger.recordBlockedInteractionRequest({ method: 'GET', url: 'https://example.test/api', reason: 'INTERACTION_FROZEN' });
    ledger.recordBlockedInteractionNavigation({ method: 'GET', url: 'https://example.test/next', reason: 'INTERACTION_FROZEN' });
    ledger.recordBlockedPopup({ url: 'https://example.test/popup', reason: 'INTERACTION_FROZEN' });
    ledger.recordBlockedDownload({ url: 'https://example.test/file.pdf', suggestedFilename: 'file.pdf', reason: 'PASSIVE_DOWNLOAD' });
    ledger.recordBlockedInteractionWebSocket({ url: 'wss://example.test/live', reason: 'INTERACTION_FROZEN' });
    ledger.recordExternalSchemeNavigation({
      url: 'tel:+10000000000',
      scheme: 'tel',
      frame: 'MAIN',
      phase: 'PASSIVE',
      reason: 'EXTERNAL_SCHEME_NAVIGATION',
    });
    ledger.recordInvariantViolation({ code: 'GUARD_FAILURE', message: 'guard failed' });
    for (let index = 0; index < 257; index += 1) {
      ledger.recordBlockedPopup({ url: `https://example.test/popup/${index}`, reason: 'INTERACTION_FROZEN' });
    }
    return ledger;
  }

  it('keeps every page event record and the record limits, and leaves out the invariant violations', () => {
    const snapshot = ledgerWithEveryRecord().snapshot();

    const evidence = safetyEventsEvidenceFromSnapshot(snapshot, 'PASSIVE');

    expect(evidence).toEqual({
      scope: 'PASSIVE',
      blockedRequestsByMethod: snapshot.blockedRequestsByMethod,
      blockedRequests: snapshot.blockedRequests,
      blockedNavigations: snapshot.blockedNavigations,
      blockedWebSockets: snapshot.blockedWebSockets,
      blockedExternalActions: snapshot.blockedExternalActions,
      excludedInteractionCandidates: snapshot.excludedInteractionCandidates,
      blockedInteractionRequests: snapshot.blockedInteractionRequests,
      blockedInteractionNavigations: snapshot.blockedInteractionNavigations,
      blockedPopups: snapshot.blockedPopups,
      blockedDownloads: snapshot.blockedDownloads,
      blockedInteractionWebSockets: snapshot.blockedInteractionWebSockets,
      externalSchemeNavigations: snapshot.externalSchemeNavigations,
      recordLimits: snapshot.recordLimits,
    });
    expect(evidence).not.toHaveProperty('invariantViolations');
    expect(evidence).not.toHaveProperty('invariantViolationCount');
    expect(evidence.blockedRequestsByMethod).toEqual({ POST: 1 });
    expect(evidence.blockedPopups).toHaveLength(256);
    expect(evidence.recordLimits).toMatchObject({ truncated: true, droppedEventCount: 2, reachedCategories: ['blockedPopups'] });
    // 元の snapshot は変えない（違反は Run Status の入力として残る）。
    expect(snapshot.invariantViolations).toEqual([{ code: 'GUARD_FAILURE', message: 'guard failed' }]);
    expect(snapshot.invariantViolationCount).toBe(1);
  });

  it.each(['PASSIVE', 'INTERACTION'] as const)('attaches the %s scope', (scope) => {
    const evidence = safetyEventsEvidenceFromSnapshot(new SafetyLedger().snapshot(), scope);

    expect(evidence.scope).toBe(scope);
    expect(Object.keys(evidence)[0]).toBe('scope');
  });

  it('returns a deeply frozen payload', () => {
    const evidence = safetyEventsEvidenceFromSnapshot(ledgerWithEveryRecord().snapshot(), 'INTERACTION');

    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.blockedRequestsByMethod)).toBe(true);
    expect(Object.isFrozen(evidence.recordLimits)).toBe(true);
    expect(Object.isFrozen(evidence.recordLimits.reachedCategories)).toBe(true);
    for (const events of [
      evidence.blockedRequests,
      evidence.blockedNavigations,
      evidence.blockedWebSockets,
      evidence.blockedExternalActions,
      evidence.excludedInteractionCandidates,
      evidence.blockedInteractionRequests,
      evidence.blockedInteractionNavigations,
      evidence.blockedPopups,
      evidence.blockedDownloads,
      evidence.blockedInteractionWebSockets,
      evidence.externalSchemeNavigations,
    ]) {
      expect(Object.isFrozen(events)).toBe(true);
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((event) => Object.isFrozen(event))).toBe(true);
    }
    expect(() => {
      (evidence as { scope: string }).scope = 'PASSIVE';
    }).toThrow();
  });

  it('types the payload as the safety Evidence and the snapshot as the payload fields plus the violations', () => {
    expectTypeOf(safetyEventsEvidenceFromSnapshot).parameters
      .toEqualTypeOf<[SafetyLedgerSnapshot, SafetyEvidenceScope]>();
    expectTypeOf(safetyEventsEvidenceFromSnapshot).returns.toEqualTypeOf<SafetyEventsEvidence>();
    expectTypeOf<EvidencePayloadByType['safety']>().toEqualTypeOf<SafetyEventsEvidence>();
    expectTypeOf<Omit<SafetyLedgerSnapshot, 'invariantViolations' | 'invariantViolationCount'>>()
      .toEqualTypeOf<Omit<SafetyEventsEvidence, 'scope'>>();
    expectTypeOf<SafetyLedgerSnapshot['invariantViolations']>().toEqualTypeOf<readonly InvariantViolationEvent[]>();
    expectTypeOf<SafetyLedgerSnapshot['invariantViolationCount']>().toEqualTypeOf<number>();
    expectTypeOf<SafetyLedgerSnapshot>().not.toHaveProperty('scope');
  });
});

// P14a（Task 14〜17 の設計書 4.5.1）: ページで作ったすべての Safety Ledger の、違反の件数と記録の不完全さの集計。
// Evidence には違反を含めないので、Page Auditor は、この集計を `PageAuditResult` の外に返す。
describe('P14a: page safety summary from the Ledger snapshots of a page', () => {
  const violation = (code: string) => ({ code, message: `${code} message` });

  it('sums the invariant violation counts, keeps the recorded violations in order, and reports truncation', () => {
    const passive = new SafetyLedger();
    passive.recordInvariantViolation(violation('PASSIVE_A'));
    passive.recordInvariantViolation(violation('PASSIVE_B'));
    const interaction = new SafetyLedger();
    for (let index = 0; index < 257; index += 1) {
      interaction.recordBlockedPopup({ url: `https://example.test/popup/${index}`, reason: 'INTERACTION_FROZEN' });
    }
    const stress = new SafetyLedger();
    stress.recordInvariantViolation(violation('STRESS_A'));

    const summary = summarizePageSafety([passive.snapshot(), interaction.snapshot(), stress.snapshot()]);

    expect(summary).toEqual({
      invariantViolationCount: 3,
      invariantViolations: [violation('PASSIVE_A'), violation('PASSIVE_B'), violation('STRESS_A')],
      recordTruncated: true,
    } satisfies PageSafetySummary);
    expect(Object.isFrozen(summary)).toBe(true);
    expect(Object.isFrozen(summary.invariantViolations)).toBe(true);
    expect(summary.invariantViolations.every((event) => Object.isFrozen(event))).toBe(true);
  });

  it('counts the violations that the Ledger could not record', () => {
    const ledger = new SafetyLedger();
    for (let index = 0; index < 300; index += 1) {
      ledger.recordInvariantViolation(violation('GUARD_FAILURE'));
    }

    const summary = summarizePageSafety([ledger.snapshot()]);

    expect(summary.invariantViolationCount).toBe(300);
    expect(summary.invariantViolations).toHaveLength(256);
    expect(summary.recordTruncated).toBe(true);
  });

  it('reports no violation and a complete record for clean Ledgers and for no Ledger', () => {
    expect(summarizePageSafety([new SafetyLedger().snapshot(), new SafetyLedger().snapshot()])).toEqual({
      invariantViolationCount: 0,
      invariantViolations: [],
      recordTruncated: false,
    });
    expect(summarizePageSafety([])).toEqual({ invariantViolationCount: 0, invariantViolations: [], recordTruncated: false });
  });

  it('stops the violation count at the largest safe integer', () => {
    const snapshot = { ...new SafetyLedger().snapshot(), invariantViolationCount: Number.MAX_SAFE_INTEGER };

    expect(summarizePageSafety([snapshot, snapshot]).invariantViolationCount).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('gives the summary the Run Status inputs that the Run Coordinator aggregates', () => {
    const ledger = new SafetyLedger();
    ledger.recordInvariantViolation(violation('GUARD_FAILURE'));
    const summary = summarizePageSafety([ledger.snapshot()]);

    expect(deriveRunStatus(runStatusInput({
      safetyInvariantViolations: summary.invariantViolationCount,
      safetyLedgerTruncated: summary.recordTruncated,
    }))).toBe('ABORTED_BY_SAFETY');
    expectTypeOf(summarizePageSafety).parameters.toEqualTypeOf<[readonly SafetyLedgerSnapshot[]]>();
    expectTypeOf(summarizePageSafety).returns.toEqualTypeOf<PageSafetySummary>();
  });
});

// CC-014（P14a）: 外部への作用の理由は、閉じた一覧（`BLOCKED_EXTERNAL_ACTION_REASONS`）にする。
describe('CC-014: blocked external action reasons', () => {
  const candidateId = 'interaction-candidate:sha256:' + 'c'.repeat(64);

  it.each(BLOCKED_EXTERNAL_ACTION_REASONS)('records the reason %s as it is', (reason) => {
    const ledger = new SafetyLedger();
    ledger.recordBlockedExternalAction({ candidateId, url: null, reason });

    expect(ledger.snapshot().blockedExternalActions).toEqual([{ candidateId, url: null, reason }]);
    expect(ledger.snapshot().recordLimits.truncatedTextCount).toBe(0);
  });

  it('types the reason as the closed list', () => {
    expectTypeOf<Parameters<SafetyLedger['recordBlockedExternalAction']>[0]['reason']>()
      .toEqualTypeOf<BlockedExternalActionReason>();
  });

  // 外部への作用として記録する理由の一覧は、除外の理由ごとの記録先を決める `interactionRejectionLedgerRecord` と一致する。
  it.each(INTERACTION_REJECTION_REASONS)(
    'agrees with interactionRejectionLedgerRecord on whether %s is a blocked external action',
    (reason: InteractionRejectionReasonEvidence) => {
      expect(isBlockedExternalActionReason(reason)).toBe(interactionRejectionLedgerRecord(reason) === 'BLOCKED_EXTERNAL_ACTION');
    },
  );
});

// P18b（Task 18 の前の整理の設計書 第5章）: Safety の型。型だけの変更で、振る舞いと JSON の形は変えない
// （振る舞いは、このファイルの既存のテストを変えずに PASS することで確かめる）。
describe('P18b: Safety Ledger types (CC-015, CC-028)', () => {
  const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

  // CC-015: 不変条件の違反の型は、core（`src/core/contracts.ts`）の1つにする。Ledger の型は、その別名にする。
  it('types the Ledger invariant violation as the core type and rejects a wrongly shaped violation (CC-015)', () => {
    expectTypeOf<InvariantViolationEvent>().toEqualTypeOf<SafetyInvariantViolationSummary>();
    expectTypeOf<Parameters<SafetyLedger['recordInvariantViolation']>[0]>().toEqualTypeOf<SafetyInvariantViolationSummary>();
    expectTypeOf<SafetyLedgerSnapshot['invariantViolations']>().toEqualTypeOf<PageSafetySummary['invariantViolations']>();
    expectTypeOf<SafetyLedgerSnapshot['invariantViolations']>().toEqualTypeOf<RunSafetySummary['invariantViolations']>();

    // @ts-expect-error 違反には `message` が要る。
    const missingMessage: InvariantViolationEvent = { code: 'MISSING_MESSAGE' };
    // @ts-expect-error 違反の `code` は文字列である。
    const numericCode: InvariantViolationEvent = { code: 1, message: 'numeric code' };
    // @ts-expect-error 違反に、ほかの項目は加えられない（JSON の形を変えない）。
    const extraField: InvariantViolationEvent = { code: 'EXTRA_FIELD', message: 'extra field', detail: null };
    expect([missingMessage, numericCode, extraField]).toHaveLength(3);
  });

  it('declares the invariant violation shape once, in src/core/contracts.ts, and aliases it in the Ledger (CC-015)', async () => {
    const sourceRoot = join(repositoryRoot, 'src');
    const sourceFiles = (await readdir(sourceRoot, { recursive: true }))
      .filter((name) => name.endsWith('.ts'))
      .map((name) => name.replaceAll('\\', '/'));
    const declaringFiles: string[] = [];
    for (const name of sourceFiles) {
      const source = await readFile(join(sourceRoot, name), 'utf8');
      // 違反の形（`code`、`message`）を、別名ではなく、interface として宣言している場所。
      if (/^export interface (?:SafetyInvariantViolationSummary|InvariantViolationEvent)\b/mu.test(source)) {
        declaringFiles.push(name);
      }
    }

    expect(declaringFiles).toEqual(['core/contracts.ts']);
    const ledgerSource = await readFile(join(sourceRoot, 'safety/safety-ledger.ts'), 'utf8');
    expect(ledgerSource).toMatch(/^export type InvariantViolationEvent = SafetyInvariantViolationSummary;$/mu);
  });

  // CC-028: Ledger の記録の分類の名前は、事象の一覧の名前（core の `SafetyEventKind`）と `'invariantViolations'` に限る。
  it('narrows the names of the Ledger record categories to the Safety event kinds and the invariant violations (CC-028)', () => {
    expectTypeOf<SafetyLedgerRecordCategory>().toEqualTypeOf<SafetyEventKind | 'invariantViolations'>();

    // @ts-expect-error 書き間違えた分類の名前は、型のエラーになる。
    const misspelled: SafetyLedgerRecordCategory = 'blockedRequest';
    // @ts-expect-error 事象の一覧ではない項目（`recordLimits`）は、分類ではない。
    const notAList: SafetyLedgerRecordCategory = 'recordLimits';
    // @ts-expect-error 違反の件数（`invariantViolationCount`）は、分類ではない。
    const notTheViolations: SafetyLedgerRecordCategory = 'invariantViolationCount';
    expect([misspelled, notAList, notTheViolations]).toHaveLength(3);
  });

  // CC-028 の残り（P18b の判断1）: 数えられなかった遮断の分類の名前は、閉じたテンプレートの型にする。記録の上限に達した分類の名前
  // （`reachedCategories` に残すもの）は、事象と違反の記録の分類と、この型の和である。値と JSON（`string` の配列）は変えない。
  it('closes the names of the uncounted blocked request categories into a template type (CC-028)', () => {
    const wholeMap: SafetyLedgerUncountedBlockedRequestCategory = 'blockedRequestsByMethod';
    const methodCounter: SafetyLedgerUncountedBlockedRequestCategory = 'blockedRequestsByMethod.GET.counter';
    const recordCategory: SafetyLedgerReachedCategory = 'blockedRequests';
    const uncountedCategory: SafetyLedgerReachedCategory = methodCounter;
    expectTypeOf<SafetyLedgerReachedCategory>()
      .toEqualTypeOf<SafetyLedgerRecordCategory | SafetyLedgerUncountedBlockedRequestCategory>();
    expectTypeOf<SafetyLedgerRecordLimits['reachedCategories']>().toEqualTypeOf<readonly string[]>();

    // @ts-expect-error 書き間違えた分類の名前（単数形）は、型のエラーになる。
    const misspelledMap: SafetyLedgerUncountedBlockedRequestCategory = 'blockedRequestByMethod';
    // @ts-expect-error メソッドごとの分類は、`.counter` で終わる。
    const misspelledCounter: SafetyLedgerUncountedBlockedRequestCategory = 'blockedRequestsByMethod.GET.count';
    // @ts-expect-error メソッドごとの分類は、`blockedRequestsByMethod.` で始まる。
    const otherPrefix: SafetyLedgerUncountedBlockedRequestCategory = 'blockedRequests.GET.counter';
    // @ts-expect-error 記録の上限に達した分類の名前も、書き間違いは型のエラーになる。
    const misspelledReached: SafetyLedgerReachedCategory = 'blockedRequest';
    expect([wholeMap, methodCounter, recordCategory, uncountedCategory]).toHaveLength(4);
    expect([misspelledMap, misspelledCounter, otherPrefix, misspelledReached]).toHaveLength(4);
  });
});
