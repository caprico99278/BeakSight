// T32j-1（Task 32 の設計書 4.4 の CC-050・DEF-113）: Guard の段階と要求の判定から、動作と記録を決める 1 つの関数（`decideGuardRequest`）の表。
// CDP の横取りの 2 か所（`CDP_REQUEST`、`CDP_DOCUMENT`）と route（`ROUTE`）が、この関数だけで決める。
import { describe, expect, it } from 'vitest';
import {
  decideGuardRequest,
  UNGUARDED_PAGE_REQUEST_VIOLATION_CODE,
  type GuardPhase,
  type GuardPolicyOutcome,
  type GuardRequestInput,
  type GuardRequestLayer,
} from '../../src/safety/passive-request-guard.js';

const REQUEST = Object.freeze({ method: 'POST', url: 'https://example.test/mutation' });
const LAYERS: readonly GuardRequestLayer[] = ['CDP_REQUEST', 'CDP_DOCUMENT', 'ROUTE'];
const FROZEN_PHASES: readonly GuardPhase[] = ['FROZEN_ACTIVE', 'FROZEN_CLOSING', 'FROZEN_INVALIDATING'];
const LIFECYCLE_PHASES: readonly GuardPhase[] = ['PASSIVE_CLOSING', 'PASSIVE_INVALIDATING', 'CLOSED'];

/** `evaluate` を呼んだ回数を数える入力。 */
function inputOf(overrides: Partial<GuardRequestInput> & { readonly outcome?: GuardPolicyOutcome } = {}): {
  readonly input: GuardRequestInput;
  readonly evaluated: () => number;
} {
  let count = 0;
  const outcome: GuardPolicyOutcome = overrides.outcome ?? {
    kind: 'DECISION',
    decision: { action: 'BLOCK', category: 'REQUEST', reason: 'NON_READ_METHOD' },
  };
  const input: GuardRequestInput = {
    layer: 'ROUTE',
    phase: 'PASSIVE_ACTIVE',
    ownerClosingPage: false,
    request: REQUEST,
    navigation: false,
    unguardedPageNavigation: null,
    evaluate: () => {
      count += 1;
      return outcome;
    },
    ...overrides,
  };
  return { input, evaluated: () => count };
}

describe('decideGuardRequest (CC-050)', () => {
  it.each(LAYERS.flatMap((layer) => FROZEN_PHASES.map((phase) => ({ layer, phase }))))(
    'blocks with the INTERACTION_FROZEN record in $phase at $layer, before any other rule and without the judgement',
    ({ layer, phase }) => {
      const { input, evaluated } = inputOf({
        layer,
        phase,
        ownerClosingPage: true,
        navigation: true,
        unguardedPageNavigation: 'unguarded',
      });
      expect(decideGuardRequest(input)).toEqual({ kind: 'BLOCK_FROZEN', request: REQUEST, navigation: true });
      expect(evaluated()).toBe(0);
    },
  );

  it('keeps the frozen block without a record when the CDP layer could not read the request', () => {
    const { input } = inputOf({ layer: 'CDP_REQUEST', phase: 'FROZEN_ACTIVE', request: null });
    expect(decideGuardRequest(input)).toEqual({ kind: 'BLOCK_FROZEN', request: null, navigation: false });
  });

  it.each(LAYERS.flatMap((layer) => LIFECYCLE_PHASES.map((phase) => ({ layer, phase }))))(
    'blocks without a record in $phase at $layer',
    ({ layer, phase }) => {
      const { input, evaluated } = inputOf({ layer, phase, unguardedPageNavigation: 'unguarded' });
      expect(decideGuardRequest(input)).toEqual({ kind: 'BLOCK_LIFECYCLE' });
      expect(evaluated()).toBe(0);
    },
  );

  it('blocks a request of a page whose owner close started, without a record', () => {
    const { input, evaluated } = inputOf({ layer: 'CDP_REQUEST', ownerClosingPage: true });
    expect(decideGuardRequest(input)).toEqual({ kind: 'BLOCK_LIFECYCLE' });
    expect(evaluated()).toBe(0);
  });

  it.each([
    { layer: 'CDP_REQUEST', code: 'CDP_REQUEST_PHASE_INVALID', message: 'Paused request observed during INSTALLING' },
    { layer: 'CDP_DOCUMENT', code: 'CDP_DOCUMENT_PHASE_INVALID', message: 'Paused Document observed during INSTALLING' },
    { layer: 'ROUTE', code: 'HTTP_ROUTE_PHASE_INVALID', message: 'HTTP route observed during INSTALLING' },
  ] as const)('records the phase violation of $layer outside PASSIVE_ACTIVE', ({ layer, code, message }) => {
    const { input, evaluated } = inputOf({ layer, phase: 'INSTALLING' });
    expect(decideGuardRequest(input)).toEqual({ kind: 'BLOCK_INVALID', violation: { code, message } });
    expect(evaluated()).toBe(0);
  });

  it('records the missing request facts in PASSIVE_ACTIVE', () => {
    const { input, evaluated } = inputOf({ layer: 'CDP_REQUEST', request: null });
    expect(decideGuardRequest(input)).toEqual({
      kind: 'BLOCK_INVALID',
      violation: { code: 'CDP_REQUEST_FACTS_INVALID', message: 'Paused request had no method or URL' },
    });
    expect(evaluated()).toBe(0);
  });

  it('DEF-113: stops a navigation of a page without the Guard CDP session with the explicit reason, without the judgement', () => {
    const { input, evaluated } = inputOf({ navigation: true, unguardedPageNavigation: 'Navigation started before explicit page readiness: GET x' });
    expect(decideGuardRequest(input)).toEqual({
      kind: 'BLOCK_INVALID',
      violation: { code: UNGUARDED_PAGE_REQUEST_VIOLATION_CODE, message: 'Navigation started before explicit page readiness: GET x' },
    });
    expect(UNGUARDED_PAGE_REQUEST_VIOLATION_CODE).toBe('PASSIVE_GUARD_PAGE_NOT_READY');
    expect(evaluated()).toBe(0);
  });

  it('follows the judgement in PASSIVE_ACTIVE, calling it once', () => {
    const blocked = inputOf();
    expect(decideGuardRequest(blocked.input)).toEqual({
      kind: 'BLOCK_POLICY',
      request: REQUEST,
      decision: { action: 'BLOCK', category: 'REQUEST', reason: 'NON_READ_METHOD' },
    });
    expect(blocked.evaluated()).toBe(1);

    const allowed = inputOf({ outcome: { kind: 'DECISION', decision: { action: 'ALLOW', delivery: 'DIRECT' } } });
    expect(decideGuardRequest(allowed.input)).toEqual({
      kind: 'ALLOW',
      request: REQUEST,
      decision: { action: 'ALLOW', delivery: 'DIRECT' },
    });
    expect(allowed.evaluated()).toBe(1);
  });

  it('maps the preparation outcomes of a layer (CORS preflight, failed preparation)', () => {
    expect(decideGuardRequest(inputOf({ layer: 'CDP_REQUEST', outcome: { kind: 'PREFLIGHT' } }).input)).toEqual({ kind: 'FULFILL_PREFLIGHT' });
    expect(decideGuardRequest(inputOf({ layer: 'CDP_DOCUMENT', outcome: { kind: 'UNAVAILABLE' } }).input)).toEqual({ kind: 'BLOCK_UNAVAILABLE' });
  });
});
