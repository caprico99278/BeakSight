// T37b（Task 37 の設計書 3.2 の「Guard の観察の形」）: 送らずに観察する probe の口（`src/safety/submission-observation.ts`）と、凍結の段の
// Guard の判定（`decideGuardRequest` の `frozenPreflight`）。
// - 口は、既定で無効。`begin` から `end` の間だけ、承認した API の Origin への事前確認を満たしてよいと答え、止めた本番の要求の型を受ける
//   （読み取りは数だけ。1 回の観察の型の数には上限）。口が無効の間は、何も受けない。Safety Ledger とは別。
// - 判定: 凍結の段（`FROZEN_ACTIVE`）で `frozenPreflight` が真の要求だけ、事前確認を満たす（`FULFILL_PREFLIGHT`）。ほかの凍結の段（閉じる途中・
//   無効化）、持ち主が閉じ始めた page、口のない入力は、今どおり `BLOCK_FROZEN`。
import { describe, expect, it } from 'vitest';
import {
  decideGuardRequest,
  type GuardPhase,
  type GuardRequestInput,
} from '../../src/safety/passive-request-guard.js';
import {
  MAX_OBSERVED_SUBMISSION_SHAPES,
  SubmissionObservation,
  attachSubmissionObservation,
  observationAdmitsFrozenPreflight,
  recordObservedFrozenPreflight,
  recordObservedFrozenRequest,
} from '../../src/safety/submission-observation.js';

const APP = 'https://app.example.test';
const API = 'https://api.example.test';
const MARKER = 'bsmarkerObservationQ1';
const SECRET = 'kSecretApiKeyValue0123456789abcdef';

const observationOf = (): SubmissionObservation => new SubmissionObservation({ approvedApiOrigins: [API], allowedOrigins: [APP] });

const requestFacts = (method: string, url = `${API}/rest/v1/members`) => ({
  method,
  url,
  resourceType: 'fetch',
  headers: { 'content-type': 'application/json', apikey: SECRET },
  body: () => ({ kind: 'TEXT' as const, text: JSON.stringify({ name: MARKER }) }),
});

describe('SubmissionObservation (T37b)', () => {
  it('is inactive by default and receives nothing while inactive', () => {
    const observation = observationOf();
    expect(observation.active).toBe(false);
    expect(observationAdmitsFrozenPreflight(observation, `${API}/rest/v1/members`)).toBe(false);
    recordObservedFrozenRequest(observation, requestFacts('POST'));
    recordObservedFrozenPreflight(observation);
    observation.begin({ pagePath: '/admin/members/new', markers: [MARKER] });
    expect(observation.end()).toEqual({ shapes: [], nonReadRequestCount: 0, readRequestCount: 0, unrecordedShapeCount: 0, preflightsFulfilled: 0 });
  });

  it('admits the preflight only to the approved API Origin while active', () => {
    const observation = observationOf();
    observation.begin({ pagePath: '/admin/members/new', markers: [] });
    expect(observationAdmitsFrozenPreflight(observation, `${API}/rest/v1/members`)).toBe(true);
    expect(observationAdmitsFrozenPreflight(observation, `${APP}/api/members`)).toBe(false);
    expect(observationAdmitsFrozenPreflight(observation, 'https://elsewhere.example.test/rest/v1/members')).toBe(false);
    expect(observationAdmitsFrozenPreflight(observation, 'not a url')).toBe(false);
    observation.end();
    expect(observationAdmitsFrozenPreflight(observation, `${API}/rest/v1/members`)).toBe(false);
  });

  it('receives the shape of a blocked non-read request and only counts the reads and the preflights', () => {
    const observation = observationOf();
    observation.begin({ pagePath: '/admin/members/new', markers: [MARKER] });
    recordObservedFrozenRequest(observation, requestFacts('POST'));
    recordObservedFrozenRequest(observation, requestFacts('GET'));
    recordObservedFrozenRequest(observation, requestFacts('head'));
    recordObservedFrozenPreflight(observation);
    const result = observation.end();
    expect(result).toMatchObject({ nonReadRequestCount: 1, readRequestCount: 2, unrecordedShapeCount: 0, preflightsFulfilled: 1 });
    expect(result.shapes).toHaveLength(1);
    expect(result.shapes[0]).toMatchObject({ method: 'POST', origin: { kind: 'APPROVED_API', index: 0 }, body: { markerKeys: [{ key: 'name', markers: [0] }] } });
    const text = JSON.stringify(result);
    expect(text).not.toContain(MARKER);
    expect(text).not.toContain(SECRET);
    expect(observation.active).toBe(false);
  });

  it('classifies the Origin by the Origin owner: the index of the approved API Origin, the allowed Origin, or another', () => {
    const observation = new SubmissionObservation({ approvedApiOrigins: ['https://first-api.example.test', API], allowedOrigins: [APP] });
    observation.begin({ pagePath: '/admin/members/new', markers: [] });
    for (const url of [`${API}/rest/v1/members`, 'https://first-api.example.test/x', `${APP}/api/members`, 'https://elsewhere.example.test/x', 'not a url']) {
      recordObservedFrozenRequest(observation, requestFacts('POST', url));
    }
    expect(observation.end().shapes.map(({ origin }) => origin)).toEqual([
      { kind: 'APPROVED_API', index: 1 },
      { kind: 'APPROVED_API', index: 0 },
      { kind: 'ALLOWED' },
      { kind: 'OTHER' },
      { kind: 'OTHER' },
    ]);
  });

  it('judges the state key with the name before hiding (T37R-fix-A I-3), keeping only the truth value', () => {
    const observation = observationOf();
    observation.begin({ pagePath: '/admin/members/new', markers: [] });
    const longStateName = `deleted_${'x'.repeat(70)}`;
    recordObservedFrozenRequest(observation, { ...requestFacts('POST'), body: () => ({ kind: 'TEXT' as const, text: JSON.stringify({ [longStateName]: true }) }) });
    recordObservedFrozenRequest(observation, requestFacts('POST'));
    const { shapes } = observation.end();
    expect(shapes.map((shape) => shape.body.stateKeyPresent)).toEqual([true, false]);
    expect(JSON.stringify(shapes)).not.toContain('deleted_');
  });

  it('does not read the body of a read request', () => {
    const observation = observationOf();
    observation.begin({ pagePath: '/admin', markers: [] });
    let bodyReads = 0;
    recordObservedFrozenRequest(observation, { ...requestFacts('GET'), body: () => {
      bodyReads += 1;
      return { kind: 'NONE' as const };
    } });
    observation.end();
    expect(bodyReads).toBe(0);
  });

  it('keeps the limit of the shapes of one observation and counts the rest as unrecorded', () => {
    const observation = observationOf();
    observation.begin({ pagePath: '/admin/members/new', markers: [] });
    for (let index = 0; index < MAX_OBSERVED_SUBMISSION_SHAPES + 2; index += 1) recordObservedFrozenRequest(observation, requestFacts('POST'));
    const result = observation.end();
    expect(result.shapes).toHaveLength(MAX_OBSERVED_SUBMISSION_SHAPES);
    expect(result).toMatchObject({ nonReadRequestCount: MAX_OBSERVED_SUBMISSION_SHAPES + 2, unrecordedShapeCount: 2 });
  });

  it('counts a request whose shape could not be made as unrecorded, without throwing', () => {
    const observation = observationOf();
    observation.begin({ pagePath: '/admin/members/new', markers: [] });
    recordObservedFrozenRequest(observation, { ...requestFacts('POST'), body: () => {
      throw new Error(`body failure ${SECRET}`);
    } });
    expect(observation.end()).toMatchObject({ shapes: [], nonReadRequestCount: 1, unrecordedShapeCount: 1 });
  });

  it('starts each observation empty', () => {
    const observation = observationOf();
    observation.begin({ pagePath: '/admin/members/new', markers: [] });
    recordObservedFrozenRequest(observation, requestFacts('POST'));
    observation.end();
    observation.begin({ pagePath: '/admin/members/new', markers: [] });
    expect(observation.end()).toMatchObject({ shapes: [], nonReadRequestCount: 0 });
  });

  it('rejects a second begin, an end without begin, a bad target, and a second attachment to a Guard', () => {
    const observation = observationOf();
    expect(() => observation.end()).toThrow(Error);
    expect(() => observation.begin({ pagePath: 'admin', markers: [] })).toThrow(TypeError);
    expect(() => observation.begin({ pagePath: '/admin', markers: [1 as unknown as string] })).toThrow(TypeError);
    expect(observation.active).toBe(false);
    observation.begin({ pagePath: '/admin', markers: [] });
    expect(() => observation.begin({ pagePath: '/admin', markers: [] })).toThrow(Error);
    observation.end();
    attachSubmissionObservation(observation);
    expect(() => attachSubmissionObservation(observation)).toThrow(TypeError);
    expect(() => new SubmissionObservation({ approvedApiOrigins: [1 as unknown as string], allowedOrigins: [] })).toThrow(TypeError);
  });
});

describe('decideGuardRequest with the frozen preflight of the observation (T37b)', () => {
  const PREFLIGHT = Object.freeze({ method: 'OPTIONS', url: `${API}/rest/v1/members` });
  const inputOf = (overrides: Partial<GuardRequestInput>): { readonly input: GuardRequestInput; readonly asked: () => number } => {
    let asked = 0;
    return {
      input: {
        layer: 'CDP_REQUEST',
        phase: 'FROZEN_ACTIVE',
        ownerClosingPage: false,
        request: PREFLIGHT,
        navigation: false,
        unguardedPageNavigation: null,
        evaluate: () => {
          throw new Error('the judgement is not called in the frozen stage');
        },
        frozenPreflight: () => {
          asked += 1;
          return true;
        },
        ...overrides,
      },
      asked: () => asked,
    };
  };

  it('fulfills the preflight that the observation admits in FROZEN_ACTIVE', () => {
    const { input, asked } = inputOf({});
    expect(decideGuardRequest(input)).toEqual({ kind: 'FULFILL_PREFLIGHT' });
    expect(asked()).toBe(1);
  });

  it('keeps BLOCK_FROZEN when the observation does not admit it', () => {
    const { input } = inputOf({ frozenPreflight: () => false });
    expect(decideGuardRequest(input)).toEqual({ kind: 'BLOCK_FROZEN', request: PREFLIGHT, navigation: false });
  });

  it('keeps BLOCK_FROZEN without the observation input', () => {
    const { input } = inputOf({ frozenPreflight: undefined });
    expect(decideGuardRequest(input)).toEqual({ kind: 'BLOCK_FROZEN', request: PREFLIGHT, navigation: false });
  });

  it.each(['FROZEN_CLOSING', 'FROZEN_INVALIDATING'] as const satisfies readonly GuardPhase[])(
    'keeps BLOCK_FROZEN in %s without asking',
    (phase) => {
      const { input, asked } = inputOf({ phase });
      expect(decideGuardRequest(input)).toEqual({ kind: 'BLOCK_FROZEN', request: PREFLIGHT, navigation: false });
      expect(asked()).toBe(0);
    },
  );

  it('keeps BLOCK_FROZEN for a page whose owner close started, or without the request facts, without asking', () => {
    const closing = inputOf({ ownerClosingPage: true });
    expect(decideGuardRequest(closing.input)).toEqual({ kind: 'BLOCK_FROZEN', request: PREFLIGHT, navigation: false });
    expect(closing.asked()).toBe(0);
    const unread = inputOf({ request: null });
    expect(decideGuardRequest(unread.input)).toEqual({ kind: 'BLOCK_FROZEN', request: null, navigation: false });
    expect(unread.asked()).toBe(0);
  });
});
