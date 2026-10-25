// T32j-1（Task 32 の設計書 4.4 の CC-050・DEF-113）: Guard の段階と要求の判定から、動作と記録を決める 1 つの関数（`decideGuardRequest`）の表。
// CDP の横取りの 2 か所（`CDP_REQUEST`、`CDP_DOCUMENT`）と route（`ROUTE`）が、この関数だけで決める。
import { describe, expect, it } from 'vitest';
import {
  decideGuardRequest,
  PAGE_INITIATED_NAVIGATION_LIMIT_PER_FRAME,
  PAGE_SUBRESOURCE_REQUEST_LIMIT,
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
    // DEF-144: 違反に、結びつく要求（method と URL。Ledger が Origin と path だけを残す）を付ける。
    expect(decideGuardRequest(input)).toEqual({ kind: 'BLOCK_INVALID', violation: { code, message, request: REQUEST } });
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
      violation: { code: UNGUARDED_PAGE_REQUEST_VIOLATION_CODE, message: 'Navigation started before explicit page readiness: GET x', request: REQUEST },
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

  // DEF-129: ページが始めた main frame の読み込みの数の上限は、この 1 か所で、判定が通す読み込みだけを数えて決める（判定が止める読み込みは数えない）。
  // 凍結と閉じる途中は、今どおり先に決まり、数えない。
  it('blocks a main frame load started by the page over the limit after the judgement allows it, and counts nothing blocked, frozen or closing', () => {
    const allowed = { kind: 'DECISION', decision: { action: 'ALLOW', delivery: 'DIRECT' } } as const;
    let admissions = 0;
    const admit = (result: boolean) => (): boolean => {
      admissions += 1;
      return result;
    };
    const over = inputOf({ layer: 'CDP_DOCUMENT', navigation: true, outcome: allowed, admitPageNavigation: admit(false) });
    expect(decideGuardRequest(over.input)).toEqual({
      kind: 'BLOCK_POLICY', request: REQUEST, decision: { action: 'BLOCK', category: 'REQUEST', reason: 'PAGE_NAVIGATION_LIMIT_REACHED' },
    });
    expect(over.evaluated()).toBe(1);
    const within = inputOf({ layer: 'CDP_DOCUMENT', navigation: true, outcome: allowed, admitPageNavigation: admit(true) });
    expect(decideGuardRequest(within.input)).toEqual({ kind: 'ALLOW', request: REQUEST, decision: allowed.decision });
    expect(within.evaluated()).toBe(1);
    expect(admissions).toBe(2);
    // 判定が止める読み込みは、数えずに今の理由で止める。
    expect(decideGuardRequest(inputOf({ layer: 'CDP_DOCUMENT', navigation: true, admitPageNavigation: admit(false) }).input)).toMatchObject({
      kind: 'BLOCK_POLICY', decision: { reason: 'NON_READ_METHOD' },
    });
    expect(admissions).toBe(2);
    decideGuardRequest(inputOf({ layer: 'CDP_DOCUMENT', phase: 'FROZEN_ACTIVE', navigation: true, admitPageNavigation: admit(false) }).input);
    decideGuardRequest(inputOf({ layer: 'CDP_DOCUMENT', phase: 'PASSIVE_CLOSING', navigation: true, admitPageNavigation: admit(false) }).input);
    expect(admissions).toBe(2);
    expect(PAGE_INITIATED_NAVIGATION_LIMIT_PER_FRAME).toBe(2);
  });

  // DEF-130-fix: ページが出す文書でない要求の数の上限も、この 1 か所で、判定が通す要求だけを数えて決める（判定が止める要求、凍結と閉じる途中は数えない）。
  it('blocks a subresource request over the limit after the judgement allows it, and counts nothing blocked, frozen or closing', () => {
    const allowed = { kind: 'DECISION', decision: { action: 'ALLOW', delivery: 'DIRECT' } } as const;
    let admissions = 0;
    const admit = (result: boolean) => (): boolean => {
      admissions += 1;
      return result;
    };
    const over = inputOf({ layer: 'CDP_REQUEST', outcome: allowed, admitSubresourceRequest: admit(false) });
    expect(decideGuardRequest(over.input)).toEqual({
      kind: 'BLOCK_POLICY', request: REQUEST, decision: { action: 'BLOCK', category: 'REQUEST', reason: 'PAGE_SUBRESOURCE_LIMIT_REACHED' },
    });
    const within = inputOf({ layer: 'CDP_REQUEST', outcome: allowed, admitSubresourceRequest: admit(true) });
    expect(decideGuardRequest(within.input)).toEqual({ kind: 'ALLOW', request: REQUEST, decision: allowed.decision });
    expect(admissions).toBe(2);
    expect(decideGuardRequest(inputOf({ layer: 'CDP_REQUEST', admitSubresourceRequest: admit(false) }).input)).toMatchObject({
      kind: 'BLOCK_POLICY', decision: { reason: 'NON_READ_METHOD' },
    });
    decideGuardRequest(inputOf({ layer: 'CDP_REQUEST', phase: 'FROZEN_ACTIVE', admitSubresourceRequest: admit(false) }).input);
    decideGuardRequest(inputOf({ layer: 'CDP_REQUEST', phase: 'PASSIVE_CLOSING', admitSubresourceRequest: admit(false) }).input);
    decideGuardRequest(inputOf({ layer: 'CDP_REQUEST', outcome: { kind: 'PREFLIGHT' }, admitSubresourceRequest: admit(false) }).input);
    expect(admissions).toBe(2);
    expect(PAGE_SUBRESOURCE_REQUEST_LIMIT).toBe(1_000);
  });
});
