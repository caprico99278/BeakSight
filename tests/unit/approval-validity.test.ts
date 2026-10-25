// T28a（Task 28 の設計書 3 章、4.3）: 再承認の判定（`src/control/approval/approval-validity.ts`。純粋。時計を引数で受ける）。
// - 今のシナリオ・今の事実・最後の承認と撤回の記録から、`APPROVED` か、理由の閉じた一覧（13 種）を返す。複数あれば決まった順で全部返す。
// - 期限の境（ちょうど期限の時刻は期限切れ）、撤回の後、版の違い、候補の `MISSING`・`NOT_REVISITED`・`CHANGED`。
import { describe, expect, it } from 'vitest';
import { computeApprovalDigest } from '../../src/control/approval/approval-digest.js';
import {
  APPROVAL_INVALIDITY_REASONS,
  approvalExpiresAtOf,
  evaluateApprovalValidity,
  type ApprovalCurrentFacts,
  type ApprovalValidity,
  type ApprovalValidityInput,
} from '../../src/control/approval/approval-validity.js';
import type { ScenarioRevision } from '../../src/control/approval/scenario-contracts.js';
import { dateOfCompactUtcTimestamp } from '../../src/core/utc-timestamp.js';
import {
  AUTH_SETUP_DIGEST,
  CREATE_CANDIDATE,
  FULL_VERIFICATION,
  INPUT_RULES,
  PROFILE_ID,
  READ_CHECK_FACTS,
  TARGET_CONFIG_DIGEST,
  UPDATE_CANDIDATE,
  sampleApproval,
  sampleRevocation,
  sampleScenario,
} from './approval-samples.js';

const SCENARIO = sampleScenario();
const FULL_READ = FULL_VERIFICATION.readVerification;
if (FULL_READ === null) {
  throw new Error('the sample verification spec must have a READ verification');
}

const FACTS: ApprovalCurrentFacts = Object.freeze<ApprovalCurrentFacts>({
  profile: { profileId: PROFILE_ID, revision: 4, status: 'ACTIVE', mode: 'TEST_APPROVED_WRITE', approvedServiceOrigins: [] },
  authSetupDigest: AUTH_SETUP_DIGEST,
  targetConfigDigest: TARGET_CONFIG_DIGEST,
  candidate: { identityDigest: CREATE_CANDIDATE.identityDigest, ruleDigest: CREATE_CANDIDATE.ruleDigest, classification: 'CREATE', drift: 'UNCHANGED' },
  // T31b: 型にした識別の digest の一覧（UPDATE だけが使う。CREATE の判定は見ない）。
  templatedCandidates: null,
  // T38c: 候補の型の digest の一覧（API のシナリオだけが使う。FORM の判定は見ない）。
  candidateShapeDigests: null,
  // T38R-fix: 鍵と欄の対応の digest の一覧、型の Origin の番号、最新の発見の改訂（API のシナリオだけが使う）。
  candidateKeyFieldDigests: null,
  apiShapeOriginIndex: null,
  latestDiscoveryProfileRevision: null,
  inputRuleReference: INPUT_RULES,
  readChecks: READ_CHECK_FACTS,
});

const digestOf = (scenario: ScenarioRevision = SCENARIO, facts: ApprovalCurrentFacts = FACTS): string => computeApprovalDigest(scenario, {
  profileRevision: facts.profile.revision,
  authSetupDigest: facts.authSetupDigest,
  targetConfigDigest: facts.targetConfigDigest,
});

const APPROVAL = sampleApproval(digestOf());
/** 承認の時刻の 1 日後（期限の中）。 */
const NOW = new Date(Date.parse('2026-10-13T02:00:00Z'));

const input = (overrides: Partial<ApprovalValidityInput> = {}): ApprovalValidityInput => ({
  scenario: SCENARIO,
  facts: FACTS,
  lastApproval: APPROVAL,
  lastRevocation: null,
  now: NOW,
  ...overrides,
});

const reasonsOf = (validity: ApprovalValidity): readonly string[] => (validity.approved ? [] : validity.reasons);

const withFacts = (change: Partial<ApprovalCurrentFacts>): Partial<ApprovalValidityInput> => ({ facts: { ...FACTS, ...change } });
const withCandidate = (change: Partial<NonNullable<ApprovalCurrentFacts['candidate']>>): Partial<ApprovalValidityInput> =>
  withFacts({ candidate: { ...(FACTS.candidate ?? CREATE_CANDIDATE), ...change } as ApprovalCurrentFacts['candidate'] });
const withProfile = (change: Partial<ApprovalCurrentFacts['profile']>): Partial<ApprovalValidityInput> =>
  withFacts({ profile: { ...FACTS.profile, ...change } });

describe('approval validity (T28a)', () => {
  it('has the closed list of the reasons in the fixed order', () => {
    expect(APPROVAL_INVALIDITY_REASONS).toEqual([
      'SCENARIO_REVISION_CHANGED',
      'PROFILE_REVISION_CHANGED',
      'AUTH_SETUP_CHANGED',
      'TARGET_CONFIG_CHANGED',
      'CANDIDATE_CHANGED',
      'CANDIDATE_MISSING',
      // T31b: UPDATE のシナリオ（`approval-validity-update.test.ts`）。LG-3: `UPDATE_SPEC_MISSING` は捨てた。
      'CANDIDATE_TEMPLATES_UNAVAILABLE',
      // T38c: API のシナリオ（`approval-api-v4.test.ts`）。
      'CANDIDATE_SHAPE_CHANGED',
      'CANDIDATE_SHAPES_UNAVAILABLE',
      // T38R-fix（`scenario-api-review-fixes.test.ts`）。
      'CANDIDATE_FIELDS_CHANGED',
      'API_ORIGIN_NOT_APPROVED',
      'API_DISCOVERY_PROFILE_STALE',
      'INPUT_RULES_CHANGED',
      'READ_CHECK_CHANGED',
      'EXPIRED',
      'REVOKED',
      'NOT_APPROVED',
      'PROFILE_RETIRED',
      'MODE_NOT_WRITE',
    ]);
    expect(Object.isFrozen(APPROVAL_INVALIDITY_REASONS)).toBe(true);
  });

  it('returns APPROVED with the receipt and the expiry when nothing changed', () => {
    const validity = evaluateApprovalValidity(input());
    expect(validity).toEqual({ approved: true, receiptId: 'receipt-1', expiresAt: '20261111020000' });
    expect(Object.isFrozen(validity)).toBe(true);
  });

  // T28a fix round 1（発見事項 1）: 候補は、承認に固定した 2 つの digest と、最後の発見の索引の今の digest で比べる（ドリフトの印 `CHANGED` だけでは
  // 再承認にしない。承認の後にもう一度発見しなくても使える。意図した変化）。
  it('stays approved for a CHANGED drift whose rule digest is still the approved one', () => {
    expect(evaluateApprovalValidity(input(withCandidate({ drift: 'CHANGED' })))).toEqual({ approved: true, receiptId: 'receipt-1', expiresAt: '20261111020000' });
  });

  it('accepts a candidate first seen in the latest discovery (NEW), and an older revocation of another receipt', () => {
    expect(evaluateApprovalValidity(input(withCandidate({ drift: 'NEW' }))).approved).toBe(true);
    expect(evaluateApprovalValidity(input({ lastRevocation: sampleRevocation({ targetReceiptId: 'receipt-0' }) })).approved).toBe(true);
  });

  it.each<readonly [string, Partial<ApprovalValidityInput>, readonly string[]]>([
    ['a new scenario revision', { scenario: sampleScenario({ revision: 4 }) }, ['SCENARIO_REVISION_CHANGED']],
    ['a new profile revision', withProfile({ revision: 5 }), ['PROFILE_REVISION_CHANGED']],
    ['another auth setup', withFacts({ authSetupDigest: 'sha256:7777777777777777777777777777777777777777777777777777777777777777' }),
      ['AUTH_SETUP_CHANGED']],
    ['no auth setup any more', withFacts({ authSetupDigest: null }), ['AUTH_SETUP_CHANGED']],
    ['another target config', withFacts({ targetConfigDigest: '8888888888888888888888888888888888888888888888888888888888888888' }),
      ['TARGET_CONFIG_CHANGED']],
    ['a rule digest other than the bound one of the receipt', {
      lastApproval: sampleApproval(digestOf(), { bound: { ...APPROVAL.bound, candidateRuleDigest: UPDATE_CANDIDATE.ruleDigest } }),
    }, ['CANDIDATE_CHANGED']],
    ['an identity digest other than the bound one of the receipt', {
      lastApproval: sampleApproval(digestOf(), { bound: { ...APPROVAL.bound, candidateIdentityDigest: UPDATE_CANDIDATE.identityDigest } }),
    }, ['CANDIDATE_MISSING']],
    ['a CHANGED candidate with another rule digest', withCandidate({ drift: 'CHANGED', ruleDigest: UPDATE_CANDIDATE.ruleDigest }), ['CANDIDATE_CHANGED']],
    ['another rule digest', withCandidate({ ruleDigest: UPDATE_CANDIDATE.ruleDigest }), ['CANDIDATE_CHANGED']],
    ['another classification', withCandidate({ classification: 'UPDATE' }), ['CANDIDATE_CHANGED']],
    ['a candidate classified as not executable', withCandidate({ classification: 'NOT_EXECUTABLE' }), ['CANDIDATE_CHANGED']],
    ['a MISSING candidate', withCandidate({ drift: 'MISSING' }), ['CANDIDATE_MISSING']],
    ['a NOT_REVISITED candidate', withCandidate({ drift: 'NOT_REVISITED' }), ['CANDIDATE_MISSING']],
    ['no candidate in the index', withFacts({ candidate: null }), ['CANDIDATE_MISSING']],
    ['an index entry of another candidate', withCandidate({ identityDigest: UPDATE_CANDIDATE.identityDigest }), ['CANDIDATE_MISSING']],
    ['a new input rule revision', withFacts({ inputRuleReference: { ...INPUT_RULES, revision: 2 } }), ['INPUT_RULES_CHANGED']],
    ['no input rules any more', withFacts({ inputRuleReference: null }), ['INPUT_RULES_CHANGED']],
    ['a new READ check revision', withFacts({ readChecks: [{ readCheckId: 'rc-1', profileId: PROFILE_ID, revision: 3, canceledAt: null }] }),
      ['READ_CHECK_CHANGED']],
    ['a canceled READ check', withFacts({
      readChecks: [{ readCheckId: 'rc-1', profileId: PROFILE_ID, revision: 2, canceledAt: '20261012030000' }],
    }), ['READ_CHECK_CHANGED']],
    ['a missing READ check', withFacts({ readChecks: [] }), ['READ_CHECK_CHANGED']],
    ['a READ check of another profile', withFacts({ readChecks: [{ readCheckId: 'rc-1', profileId: 'other-profile', revision: 2, canceledAt: null }] }),
      ['READ_CHECK_CHANGED']],
    ['a revocation of the last approval', { lastRevocation: sampleRevocation() }, ['REVOKED']],
    ['no approval', { lastApproval: null }, ['NOT_APPROVED']],
    ['a retired profile', withProfile({ status: 'RETIRED' }), ['PROFILE_RETIRED']],
    ['a passive mode', withProfile({ mode: 'TEST_AUTH_PASSIVE' }), ['MODE_NOT_WRITE']],
    ['the public mode', withProfile({ mode: 'PUBLIC_PASSIVE' }), ['MODE_NOT_WRITE']],
  ])('requires a new approval after %s', (_label, change, reasons) => {
    expect(reasonsOf(evaluateApprovalValidity(input(change)))).toEqual(reasons);
  });

  it('reports INPUT_RULES_CHANGED when the scenario reference moved away from the approved one (attached again)', () => {
    const scenario = sampleScenario({ inputRuleReference: { ...INPUT_RULES, revision: 2 } });
    const facts = { ...FACTS, inputRuleReference: { ...INPUT_RULES, revision: 2 } };
    expect(reasonsOf(evaluateApprovalValidity(input({ scenario, facts })))).toEqual(['INPUT_RULES_CHANGED']);
  });

  it('reports INPUT_RULES_CHANGED and READ_CHECK_CHANGED even without an approval (the scenario against the facts)', () => {
    expect(reasonsOf(evaluateApprovalValidity(input({
      lastApproval: null,
      facts: { ...FACTS, inputRuleReference: null, readChecks: [] },
    })))).toEqual(['INPUT_RULES_CHANGED', 'READ_CHECK_CHANGED', 'NOT_APPROVED']);
  });

  // T30a: 照合の READ（検証の指定）の定義も、照らす READ の定義と同じく、ない・取り消した・版が違えば再承認になる。
  describe('the READ check of the verification spec (T30a)', () => {
    const verified = sampleScenario({
      verification: { ...FULL_VERIFICATION, readVerification: { ...FULL_READ, readCheckId: 'rc-2', revision: 1 } },
    });
    const verifiedInput = (readChecks: ApprovalCurrentFacts['readChecks']): ApprovalValidityInput =>
      input({ scenario: verified, lastApproval: sampleApproval(digestOf(verified)), facts: { ...FACTS, readChecks } });
    const rc1 = READ_CHECK_FACTS.filter(({ readCheckId }) => readCheckId === 'rc-1');

    it('keeps the approval while the verification READ check is unchanged', () => {
      expect(evaluateApprovalValidity(verifiedInput(READ_CHECK_FACTS)).approved).toBe(true);
    });

    it.each([
      ['missing', rc1],
      ['canceled', [...rc1, { readCheckId: 'rc-2', profileId: PROFILE_ID, revision: 1, canceledAt: '20261012030000' }]],
      ['at a new revision', [...rc1, { readCheckId: 'rc-2', profileId: PROFILE_ID, revision: 2, canceledAt: null }]],
      ['of another profile', [...rc1, { readCheckId: 'rc-2', profileId: 'other-profile', revision: 1, canceledAt: null }]],
    ] as const)('requires a new approval when the verification READ check is %s', (_label, readChecks) => {
      expect(reasonsOf(evaluateApprovalValidity(verifiedInput(readChecks)))).toEqual(['READ_CHECK_CHANGED']);
    });
  });

  // LG-3（O5）: 前の印の版（v3）の承認の digest の記録も、同じ一般の判定で `SCENARIO_REVISION_CHANGED`（`approval-api-v4.test.ts` の同じ確かめを
  // ここにまとめた。v3 の値は `approval-digest-differences.test.ts` で T31b が固定した見本の値）。
  it.each([
    ['a tampered receipt', 'sha256:9999999999999999999999999999999999999999999999999999999999999999'],
    ['a receipt of the v3 digest format', 'sha256:f1d363c24e761a844bd54a540f2d39769201813176a94b484b91410eb0f269c0'],
  ])('reports %s (the digest differs while every bound fact is equal) as SCENARIO_REVISION_CHANGED', (_label, digest) => {
    expect(reasonsOf(evaluateApprovalValidity(input({ lastApproval: sampleApproval(digest) })))).toEqual(['SCENARIO_REVISION_CHANGED']);
    expect(reasonsOf(evaluateApprovalValidity(input()))).toEqual([]);
  });

  describe('the expiry (the clock is injected)', () => {
    const expiresAt = dateOfCompactUtcTimestamp(APPROVAL.expiresAt).getTime();
    const SECOND_MS = 1_000;

    it.each([
      ['one second before the expiry', expiresAt - SECOND_MS, []],
      ['exactly at the expiry', expiresAt, ['EXPIRED']],
      ['one second after the expiry', expiresAt + SECOND_MS, ['EXPIRED']],
    ] as const)('%s', (_label, time, reasons) => {
      expect(reasonsOf(evaluateApprovalValidity(input({ now: new Date(time) })))).toEqual(reasons);
    });

    it('uses the earlier of the stored expiry and the expiry from the TTL of the approved revision (fail-closed)', () => {
      const longer = sampleApproval(digestOf(), { expiresAt: '20271012020000' });
      expect(reasonsOf(evaluateApprovalValidity(input({ lastApproval: longer, now: new Date(expiresAt) })))).toEqual(['EXPIRED']);
    });

    it('computes the expiry from the approval time and the TTL in days (UTC, 14 digits)', () => {
      expect(approvalExpiresAtOf('20261012020000', 30)).toBe('20261111020000');
      expect(approvalExpiresAtOf('20261231235959', 1)).toBe('20270101235959');
      expect(() => approvalExpiresAtOf('2026-10-12', 30)).toThrow(RangeError);
      expect(() => approvalExpiresAtOf('20261012020000', 0)).toThrow(RangeError);
      expect(() => approvalExpiresAtOf('20261012020000', 1.5)).toThrow(RangeError);
    });
  });

  it('returns every reason in the fixed order', () => {
    const validity = evaluateApprovalValidity(input({
      scenario: sampleScenario({ revision: 4 }),
      facts: {
        profile: { profileId: PROFILE_ID, revision: 5, status: 'RETIRED', mode: 'TEST_AUTH_PASSIVE', approvedServiceOrigins: [] },
        authSetupDigest: null,
        targetConfigDigest: '8888888888888888888888888888888888888888888888888888888888888888',
        candidate: { ...(FACTS.candidate ?? CREATE_CANDIDATE), drift: 'CHANGED', ruleDigest: UPDATE_CANDIDATE.ruleDigest } as ApprovalCurrentFacts['candidate'],
        templatedCandidates: null,
        candidateShapeDigests: null,
        candidateKeyFieldDigests: null,
        apiShapeOriginIndex: null,
        latestDiscoveryProfileRevision: null,
        inputRuleReference: null,
        readChecks: [],
      },
      lastRevocation: sampleRevocation(),
      now: new Date(Date.parse('2027-01-01T00:00:00Z')),
    }));
    expect(reasonsOf(validity)).toEqual([
      'SCENARIO_REVISION_CHANGED',
      'PROFILE_REVISION_CHANGED',
      'AUTH_SETUP_CHANGED',
      'TARGET_CONFIG_CHANGED',
      'CANDIDATE_CHANGED',
      'INPUT_RULES_CHANGED',
      'READ_CHECK_CHANGED',
      'EXPIRED',
      'REVOKED',
      'PROFILE_RETIRED',
      'MODE_NOT_WRITE',
    ]);
    expect(Object.isFrozen(validity) && !validity.approved && Object.isFrozen(validity.reasons)).toBe(true);
  });

  it('reports NOT_APPROVED with the checks of the scenario against the facts only (no receipt to compare, no revocation to apply)', () => {
    expect(reasonsOf(evaluateApprovalValidity(input({
      lastApproval: null,
      lastRevocation: sampleRevocation(),
      ...withProfile({ status: 'RETIRED' }),
      facts: { ...FACTS, profile: { ...FACTS.profile, status: 'RETIRED', revision: 9 }, candidate: null },
    })))).toEqual(['CANDIDATE_MISSING', 'NOT_APPROVED', 'PROFILE_RETIRED']);
  });

  it.each<readonly [string, Partial<ApprovalValidityInput>]>([
    ['facts of another profile', withProfile({ profileId: 'other-profile' })],
    ['an approval of another scenario', { lastApproval: sampleApproval(digestOf(), { scenarioId: 'scenario-2' }) }],
    ['an approval of another profile', { lastApproval: sampleApproval(digestOf(), { profileId: 'other-profile' }) }],
    ['a revocation of another scenario', { lastRevocation: sampleRevocation({ scenarioId: 'scenario-2' }) }],
    ['an invalid clock', { now: new Date(Number.NaN) }],
  ])('rejects %s as a caller error (RangeError)', (_label, change) => {
    expect(() => evaluateApprovalValidity(input(change))).toThrow(RangeError);
  });

  it('does not change the input', () => {
    const value = input({ lastRevocation: sampleRevocation() });
    const snapshot = structuredClone(value);
    evaluateApprovalValidity(value);
    expect(value).toEqual(snapshot);
  });
});
