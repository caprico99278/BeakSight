import { describe, expect, it } from 'vitest';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';

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
    expect(snapshot.invariantViolations).toEqual([{
      code: 'SAFETY_LEDGER_LIMIT_REACHED',
      message: 'blockedInteractionRequests',
    }]);
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
    expect(snapshot.invariantViolations.length).toBeLessThanOrEqual(256);
    expect(snapshot.blockedRequests[0]?.method).toHaveLength(32);
    expect(snapshot.blockedRequests[0]?.url).toHaveLength(2_048);
    expect(snapshot.blockedNavigations[0]?.method).toHaveLength(32);
    expect(snapshot.blockedNavigations[0]?.url).toHaveLength(2_048);
    expect(snapshot.blockedWebSockets[0]?.url).toHaveLength(2_048);
    expect(snapshot.invariantViolations.every((event) => (
      event.code.length <= 2_048 && event.message.length <= 2_048
    ))).toBe(true);
    expect(snapshot.invariantViolations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'SAFETY_LEDGER_LIMIT_REACHED' }),
    ]));
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
    expect(snapshot.invariantViolations.filter((event) => (
      event.code === 'SAFETY_LEDGER_LIMIT_REACHED'
      && event.message === 'blockedRequestsByMethod'
    ))).toHaveLength(1);
  });

  it('saturates a method counter and records the saturation once', () => {
    const ledger = new SafetyLedger();
    for (let index = 0; index < 65_540; index += 1) {
      ledger.recordBlockedRequest({ method: 'POST', url: 'https://example.test/', reason: 'NON_READ_METHOD' });
    }

    const snapshot = ledger.snapshot();
    expect(snapshot.blockedRequestsByMethod.POST).toBe(65_535);
    expect(snapshot.invariantViolations.filter((event) => (
      event.code === 'SAFETY_LEDGER_LIMIT_REACHED'
      && event.message === 'blockedRequestsByMethod.POST.counter'
    ))).toHaveLength(1);
  });
});
