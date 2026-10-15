// T31b（Task 31 の設計書 3 章の「型にした識別の digest」、4 章、11 章の T31b の Blocker の判断（案 D））: UPDATE のシナリオの承認の有効性
// （`approval-validity.ts`。純粋）。
// - UPDATE は、候補の識別の digest の代わりに、型にした識別の digest で候補を確かめる: 最後の発見の索引に、同じ型にした識別の digest（候補ごとの
//   一覧のどれか）と同じ規則の digest の、分類が UPDATE の候補があること。別のレコードの画面の候補でも有効。構造が変われば無効。
// - 索引の一覧の事実がまだ集められない間（版 9 の前）は、UPDATE を止める側にする（`CANDIDATE_TEMPLATES_UNAVAILABLE`）。
// - UPDATE の指定のない保存済みの版は、承認できない（`UPDATE_SPEC_MISSING`）。
// - CREATE の判定は変えない。
import { describe, expect, it } from 'vitest';
import { computeApprovalDigest } from '../../src/control/approval/approval-digest.js';
import {
  APPROVAL_INVALIDITY_REASONS,
  evaluateApprovalValidity,
  type ApprovalCurrentFacts,
  type ApprovalTemplatedCandidateFact,
  type ApprovalValidity,
  type ApprovalValidityInput,
} from '../../src/control/approval/approval-validity.js';
import type { ScenarioRevision } from '../../src/control/approval/scenario-contracts.js';
import {
  AUTH_SETUP_DIGEST,
  CREATE_CANDIDATE,
  INPUT_RULES,
  PROFILE_ID,
  READ_CHECK_FACTS,
  TARGET_CONFIG_DIGEST,
  UPDATE_CANDIDATE,
  UPDATE_TEMPLATED_IDENTITY_DIGEST,
  sampleApproval,
  sampleScenario,
  sampleUpdateScenario,
} from './approval-samples.js';

const SCENARIO = sampleUpdateScenario();

/** 別のレコードの画面の候補（型にした識別の digest の一覧に、シナリオの digest を持つ）。 */
const OTHER_RECORD: ApprovalTemplatedCandidateFact = Object.freeze({
  templatedIdentityDigests: [UPDATE_TEMPLATED_IDENTITY_DIGEST, `sha256:${'4'.repeat(64)}`],
  ruleDigest: UPDATE_CANDIDATE.ruleDigest,
  classification: 'UPDATE',
  drift: 'NEW',
});

const FACTS: ApprovalCurrentFacts = Object.freeze<ApprovalCurrentFacts>({
  profile: { profileId: PROFILE_ID, revision: 4, status: 'ACTIVE', mode: 'TEST_APPROVED_WRITE' },
  authSetupDigest: AUTH_SETUP_DIGEST,
  targetConfigDigest: TARGET_CONFIG_DIGEST,
  // 承認した画面（レコード 1）の候補は、最後の発見の索引にない（別のレコードの画面だけを見た）。
  candidate: null,
  templatedCandidates: [OTHER_RECORD],
  inputRuleReference: INPUT_RULES,
  readChecks: READ_CHECK_FACTS,
});

const digestOf = (scenario: ScenarioRevision, facts: ApprovalCurrentFacts = FACTS): string => computeApprovalDigest(scenario, {
  profileRevision: facts.profile.revision,
  authSetupDigest: facts.authSetupDigest,
  targetConfigDigest: facts.targetConfigDigest,
});

const approvalOf = (scenario: ScenarioRevision) => sampleApproval(digestOf(scenario), {
  bound: {
    ...sampleApproval(digestOf(scenario)).bound,
    candidateIdentityDigest: scenario.candidate.identityDigest,
    candidateRuleDigest: scenario.candidate.ruleDigest,
  },
});

const NOW = new Date(Date.parse('2026-10-13T02:00:00Z'));

const input = (overrides: Partial<ApprovalValidityInput> = {}): ApprovalValidityInput => ({
  scenario: SCENARIO,
  facts: FACTS,
  lastApproval: approvalOf(SCENARIO),
  lastRevocation: null,
  now: NOW,
  ...overrides,
});

const reasonsOf = (validity: ApprovalValidity): readonly string[] => (validity.approved ? [] : validity.reasons);
const withTemplated = (templatedCandidates: ApprovalCurrentFacts['templatedCandidates']): Partial<ApprovalValidityInput> =>
  ({ facts: { ...FACTS, templatedCandidates } });

describe('approval validity of an UPDATE scenario (T31b)', () => {
  it('adds the two reasons after CANDIDATE_MISSING in the closed list', () => {
    const index = APPROVAL_INVALIDITY_REASONS.indexOf('CANDIDATE_MISSING');
    expect(APPROVAL_INVALIDITY_REASONS.slice(index, index + 3)).toEqual(['CANDIDATE_MISSING', 'UPDATE_SPEC_MISSING', 'CANDIDATE_TEMPLATES_UNAVAILABLE']);
  });

  it('is approved with the page of another record in the latest discovery (same templated identity digest and rule digest)', () => {
    expect(evaluateApprovalValidity(input())).toEqual({ approved: true, receiptId: 'receipt-1', expiresAt: '20261111020000' });
  });

  it('accepts one usable candidate among others with the same templated digest', () => {
    const changed: ApprovalTemplatedCandidateFact = { ...OTHER_RECORD, ruleDigest: CREATE_CANDIDATE.ruleDigest };
    expect(evaluateApprovalValidity(input(withTemplated([changed, OTHER_RECORD]))).approved).toBe(true);
  });

  it.each([
    ['no candidate with the templated digest', [{ ...OTHER_RECORD, templatedIdentityDigests: [`sha256:${'4'.repeat(64)}`] }], 'CANDIDATE_MISSING'],
    ['no candidate at all', [], 'CANDIDATE_MISSING'],
    ['a missing candidate', [{ ...OTHER_RECORD, drift: 'MISSING' }], 'CANDIDATE_MISSING'],
    ['a candidate not revisited', [{ ...OTHER_RECORD, drift: 'NOT_REVISITED' }], 'CANDIDATE_MISSING'],
    ['another rule digest', [{ ...OTHER_RECORD, ruleDigest: CREATE_CANDIDATE.ruleDigest }], 'CANDIDATE_CHANGED'],
    ['another classification', [{ ...OTHER_RECORD, classification: 'CREATE' }], 'CANDIDATE_CHANGED'],
  ] as const)('is not approved when the structure changed (%s)', (_label, templatedCandidates, reason) => {
    expect(reasonsOf(evaluateApprovalValidity(input(withTemplated(templatedCandidates))))).toEqual([reason]);
  });

  it('stops an UPDATE scenario while the templated digests of the index cannot be collected (before the version 9)', () => {
    expect(reasonsOf(evaluateApprovalValidity(input(withTemplated(null))))).toEqual(['CANDIDATE_TEMPLATES_UNAVAILABLE']);
    expect(reasonsOf(evaluateApprovalValidity(input({ ...withTemplated(null), lastApproval: null }))))
      .toEqual(['CANDIDATE_TEMPLATES_UNAVAILABLE', 'NOT_APPROVED']);
  });

  it('never approves a stored UPDATE revision without the UPDATE spec', () => {
    const legacy = sampleUpdateScenario({ update: null });
    expect(reasonsOf(evaluateApprovalValidity(input({ scenario: legacy, lastApproval: approvalOf(legacy) })))).toEqual(['UPDATE_SPEC_MISSING']);
  });

  it('compares the bound rule digest and the bound identity digest of the approval too', () => {
    const scenario = SCENARIO;
    const approval = approvalOf(scenario);
    const otherRule = { ...approval, bound: { ...approval.bound, candidateRuleDigest: CREATE_CANDIDATE.ruleDigest } };
    expect(reasonsOf(evaluateApprovalValidity(input({ lastApproval: otherRule })))).toContain('CANDIDATE_CHANGED');
    const otherIdentity = { ...approval, bound: { ...approval.bound, candidateIdentityDigest: CREATE_CANDIDATE.identityDigest } };
    expect(reasonsOf(evaluateApprovalValidity(input({ lastApproval: otherIdentity })))).toContain('CANDIDATE_MISSING');
  });

  it('keeps the judgement of a CREATE scenario (the templated digests are not used)', () => {
    const create = sampleScenario();
    const createFacts: ApprovalCurrentFacts = {
      ...FACTS,
      candidate: { identityDigest: CREATE_CANDIDATE.identityDigest, ruleDigest: CREATE_CANDIDATE.ruleDigest, classification: 'CREATE', drift: 'UNCHANGED' },
    };
    for (const templatedCandidates of [null, []] as const) {
      const facts = { ...createFacts, templatedCandidates };
      expect(evaluateApprovalValidity(input({ scenario: create, facts, lastApproval: sampleApproval(digestOf(create, facts)) })).approved)
        .toBe(true);
    }
    expect(reasonsOf(evaluateApprovalValidity(input({
      scenario: create,
      facts: { ...createFacts, candidate: null },
      lastApproval: sampleApproval(digestOf(create)),
    })))).toEqual(['CANDIDATE_MISSING']);
  });
});
