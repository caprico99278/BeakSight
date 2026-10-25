// T28a（Task 28 の設計書 3 章の「承認を縛るもの」）: 承認の digest（`src/control/approval/approval-digest.ts`）。
// - 同じ内容は同じ値。承認を縛る各項目が変われば値が変わる（項目ごとの行）。
// - 並びの順に依らない所（送る欄の名前の集合、照らす READ の定義の参照の集合）は、並べてから求める。
// - 版の印（`APPROVAL_DIGEST_FORMAT`）を含め、SHA-256 の作成は `createSha256Fingerprint` に任せる（`sha256:<16進64桁>` の形）。
// - 作成と更新の時刻は縛らない（承認の対象ではない）。
// - T30a: 検証の指定（成功の条件・入力の誤りの条件・登録の ID の取り方・照合の READ）の各項目も縛る。項目を足したので、印の版を `/2` に上げた
//   （今までの承認はすべて、digest が変わって再承認になる。Task 30 の設計書 2 章のユーザーの判断 4）。
// - T31b: UPDATE の指定（台帳の参照、2 つの path の型、保つ欄、型にした識別の digest）の各項目も縛る。項目を足したので、印の版を `/3` に上げた
//   （今までの承認はすべて再承認になる。Task 31 の設計書 4 章の「契約」。意図した変化）。
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_DIGEST_FORMAT,
  approvalBoundFactsOf,
  computeApprovalDigest,
  type ApprovalDigestFacts,
} from '../../src/control/approval/approval-digest.js';
import type { ScenarioRevision } from '../../src/control/approval/scenario-contracts.js';
import { isSha256Fingerprint } from '../../src/core/ids.js';
import {
  AUTH_SETUP_DIGEST,
  CREATE_CANDIDATE,
  FULL_VERIFICATION,
  INPUT_RULES,
  TARGET_CONFIG_DIGEST,
  UPDATE_CANDIDATE,
  UPDATE_SPEC,
  sampleScenario,
  sampleUpdateScenario,
} from './approval-samples.js';

const FACTS: ApprovalDigestFacts = Object.freeze({
  profileRevision: 4,
  authSetupDigest: AUTH_SETUP_DIGEST,
  targetConfigDigest: TARGET_CONFIG_DIGEST,
});

const BASE = sampleScenario();
const BASE_DIGEST = computeApprovalDigest(BASE, FACTS);
const READ = FULL_VERIFICATION.readVerification;
if (READ === null) {
  throw new Error('the sample verification spec must have a READ verification');
}
/** 検証の指定の一部を変えたシナリオの変更。 */
const verificationChange = (change: Partial<ScenarioRevision['verification']>): Partial<ScenarioRevision> => ({
  verification: { ...FULL_VERIFICATION, ...change },
});
const readChange = (change: Partial<NonNullable<ScenarioRevision['verification']['readVerification']>>): Partial<ScenarioRevision> =>
  verificationChange({ readVerification: { ...READ, ...change } });

describe('approval digest (T28a)', () => {
  it('has a versioned format mark (version 4 since the API items, T38c; version 3 was the UPDATE spec, T31b) and returns a sha256 fingerprint', () => {
    expect(APPROVAL_DIGEST_FORMAT).toBe('beaksight-approval/4');
    expect(isSha256Fingerprint(BASE_DIGEST)).toBe(true);
  });

  it('returns the same value for the same content (a fresh copy, other timestamps)', () => {
    expect(computeApprovalDigest(structuredClone(BASE), { ...FACTS })).toBe(BASE_DIGEST);
    expect(computeApprovalDigest(sampleScenario({ createdAt: '20200101000000', updatedAt: '20200101000001' }), FACTS)).toBe(BASE_DIGEST);
  });

  it('does not depend on the order of the field names and of the READ check references', () => {
    const ordered = sampleScenario({
      fieldNames: ['email', 'name'],
      readChecks: [{ readCheckId: 'rc-1', revision: 2 }, { readCheckId: 'rc-2', revision: 1 }],
    });
    const reversed = sampleScenario({
      fieldNames: ['name', 'email'],
      readChecks: [{ readCheckId: 'rc-2', revision: 1 }, { readCheckId: 'rc-1', revision: 2 }],
    });
    expect(computeApprovalDigest(reversed, FACTS)).toBe(computeApprovalDigest(ordered, FACTS));
  });

  it('does not depend on the order of the bindings and of the expectations of the verification READ (T30a)', () => {
    const bindings = [{ parameterName: 'q', fieldName: 'name' }, { parameterName: 'status', fieldName: 'email' }];
    expect(computeApprovalDigest(sampleScenario(readChange({ bindings: [...bindings].reverse() })), FACTS))
      .toBe(computeApprovalDigest(sampleScenario(readChange({ bindings })), FACTS));
    expect(computeApprovalDigest(sampleScenario(readChange({ expectations: [...READ.expectations].reverse() })), FACTS)).toBe(BASE_DIGEST);
  });

  const scenarioChanges: readonly (readonly [string, Partial<ScenarioRevision>])[] = [
    ['the scenario id', { scenarioId: 'scenario-2' }],
    ['the profile id', { profileId: 'other-profile' }],
    ['the scenario revision', { revision: 4 }],
    ['the kind', { kind: 'UPDATE' }],
    ['the candidate identity digest', { candidate: { identityDigest: UPDATE_CANDIDATE.identityDigest, ruleDigest: CREATE_CANDIDATE.ruleDigest } }],
    ['the candidate rule digest', { candidate: { identityDigest: CREATE_CANDIDATE.identityDigest, ruleDigest: UPDATE_CANDIDATE.ruleDigest } }],
    ['the method override', { request: { ...BASE.request, methodOverride: 'PUT' } }],
    ['the origin', { request: { ...BASE.request, origin: 'http://127.0.0.1:4174' } }],
    ['the path', { request: { ...BASE.request, path: '/members/2' } }],
    ['the enctype', { request: { ...BASE.request, enctype: 'multipart/form-data' } }],
    ['the field names (one more)', { fieldNames: ['email', 'name', 'plan'] }],
    ['the field names (one less)', { fieldNames: ['name'] }],
    ['a side effect confirmation', { sideEffectConfirmations: { ...BASE.sideEffectConfirmations, NOT_DESTRUCTIVE: false } }],
    ['the per-run limit', { limits: { ...BASE.limits, maxCreatesPerRun: 2 } }],
    ['the cumulative limit', { limits: { ...BASE.limits, maxCumulativeCreates: 19 } }],
    ['the TTL', { approvalTtlDays: 29 }],
    ['the input rule set', { inputRuleReference: { ...INPUT_RULES, ruleSetId: 'rules-2' } }],
    ['the input rule revision', { inputRuleReference: { ...INPUT_RULES, revision: 2 } }],
    ['the input rule digest', {
      inputRuleReference: { ...INPUT_RULES, digest: 'sha256:4444444444444444444444444444444444444444444444444444444444444444' },
    }],
    ['no input rules', { inputRuleReference: null }],
    ['the READ check id', { readChecks: [{ readCheckId: 'rc-2', revision: 2 }] }],
    ['the READ check revision', { readChecks: [{ readCheckId: 'rc-1', revision: 3 }] }],
    ['no READ check', { readChecks: [] }],
    // T30a: 検証の指定の各項目。
    ['the success condition path', verificationChange({ successCondition: { pathPrefix: '/done/', selector: '.registered' } })],
    ['the success condition selector', verificationChange({ successCondition: { pathPrefix: '/members/', selector: null } })],
    ['no success condition', verificationChange({ successCondition: null })],
    ['the input error condition path', verificationChange({ inputErrorCondition: { pathPrefix: '/members/edit', selector: '.error' } })],
    ['the input error condition selector', verificationChange({ inputErrorCondition: { pathPrefix: '/members/new', selector: '.alert' } })],
    ['no input error condition', verificationChange({ inputErrorCondition: null })],
    ['the record id path pattern', verificationChange({ recordId: { source: 'URL_PATH_PATTERN', pathPattern: '/members/{id}/show' } })],
    ['the record id source', verificationChange({ recordId: { source: 'ELEMENT', selector: '/members/{id}' } })],
    ['no record id', verificationChange({ recordId: null })],
    ['the verification READ check id', readChange({ readCheckId: 'rc-2', revision: 2 })],
    ['the verification READ check revision', readChange({ revision: 3 })],
    ['the binding parameter', readChange({ bindings: [{ parameterName: 'status', fieldName: 'name' }] })],
    ['the binding field', readChange({ bindings: [{ parameterName: 'q', fieldName: 'email' }] })],
    ['one more binding', readChange({ bindings: [{ parameterName: 'q', fieldName: 'name' }, { parameterName: 'status', fieldName: 'email' }] })],
    ['the row count', readChange({ expectations: [{ kind: 'ROW_COUNT_EQUALS', count: 2 }, { kind: 'TEXT_CONTAINS', fieldName: 'email' }] })],
    ['the text field', readChange({ expectations: [{ kind: 'ROW_COUNT_EQUALS', count: 1 }, { kind: 'TEXT_CONTAINS', fieldName: 'name' }] })],
    ['a detail expectation', readChange({
      expectations: [{ kind: 'ROW_COUNT_EQUALS', count: 1 }, { kind: 'DETAIL_FIELD_EQUALS', field: 'email', fieldName: 'email' }],
    })],
    ['no READ verification', verificationChange({ readVerification: null })],
  ];

  it.each(scenarioChanges)('changes with %s', (_label, change) => {
    expect(computeApprovalDigest(sampleScenario(change), FACTS)).not.toBe(BASE_DIGEST);
  });

  it.each([
    ['the profile revision', { profileRevision: 5 }],
    ['the auth setup digest', { authSetupDigest: 'sha256:5555555555555555555555555555555555555555555555555555555555555555' }],
    ['no auth setup', { authSetupDigest: null }],
    ['the target config digest', { targetConfigDigest: '6666666666666666666666666666666666666666666666666666666666666666' }],
  ] as const)('changes with %s', (_label, change) => {
    expect(computeApprovalDigest(BASE, { ...FACTS, ...change })).not.toBe(BASE_DIGEST);
  });

  it('gives a different value to every row (no two changes collide)', () => {
    const digests = scenarioChanges.map(([, change]) => computeApprovalDigest(sampleScenario(change), FACTS));
    expect(new Set([BASE_DIGEST, ...digests]).size).toBe(digests.length + 1);
  });

  // T31b: UPDATE の指定の各項目。
  const UPDATE_BASE = sampleUpdateScenario();
  const updateChanges: readonly (readonly [string, Partial<ScenarioRevision>])[] = [
    ['the target CREATE scenario', { update: { ...UPDATE_SPEC, targetCreateScenarioId: 'scenario-create-2' } }],
    ['the form path template', { update: { ...UPDATE_SPEC, formPathTemplate: '/members/{id}/change' } }],
    ['the action path template', { update: { ...UPDATE_SPEC, actionPathTemplate: '/members/{id}/save' } }],
    ['the keep fields', { update: { ...UPDATE_SPEC, keepFieldNames: ['note'] } }],
    ['the templated identity digest', { update: { ...UPDATE_SPEC, templatedIdentityDigest: CREATE_CANDIDATE.identityDigest } }],
    ['no UPDATE spec', { update: null }],
  ];

  it.each(updateChanges)('changes with %s of the UPDATE spec (T31b)', (_label, change) => {
    expect(computeApprovalDigest(sampleUpdateScenario(change), FACTS)).not.toBe(computeApprovalDigest(UPDATE_BASE, FACTS));
  });

  it('gives a different value to every row of the UPDATE spec, and does not depend on the order of the keep fields (T31b)', () => {
    const digests = updateChanges.map(([, change]) => computeApprovalDigest(sampleUpdateScenario(change), FACTS));
    expect(new Set([computeApprovalDigest(UPDATE_BASE, FACTS), ...digests]).size).toBe(digests.length + 1);
    const keep = (keepFieldNames: readonly string[]) => sampleUpdateScenario({ update: { ...UPDATE_SPEC, keepFieldNames } });
    expect(computeApprovalDigest(keep(['note', 'email']), FACTS)).toBe(computeApprovalDigest(keep(['email', 'note']), FACTS));
  });

  it('builds the bound facts of a receipt from the scenario and the facts', () => {
    expect(approvalBoundFactsOf(BASE, FACTS)).toEqual({
      profileRevision: 4,
      authSetupDigest: AUTH_SETUP_DIGEST,
      targetConfigDigest: TARGET_CONFIG_DIGEST,
      candidateIdentityDigest: CREATE_CANDIDATE.identityDigest,
      candidateRuleDigest: CREATE_CANDIDATE.ruleDigest,
      inputRuleReference: INPUT_RULES,
    });
    expect(Object.isFrozen(approvalBoundFactsOf(BASE, FACTS))).toBe(true);
  });
});
