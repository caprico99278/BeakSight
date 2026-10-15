// T28e（Task 28 の設計書 4.6 の「最後の承認との差分」）: 承認の digest の項目ごとの差分（`src/control/approval/approval-digest.ts` の
// `approvalDigestDifferencesOf`）。
// - 差分の項目と並びは、承認の digest の項目と同じ一覧（`APPROVAL_DIGEST_ITEMS`）を使う（書き写さない）。digest の入力は、その一覧の順の値
//   （`approvalDigestEntriesOf`）を印の後に並べた JSON で、項目の一覧を使う形に直しても値は変わらない（固定の値で確かめる）。
// - 差分は、値（並べ替えた後の JSON の値）が違う項目だけを、一覧の順に、前の値と今の値で返す。同じ内容なら空。
// - T30a: 検証の指定の 4 項目を一覧の末尾に足し、印の版を `/2` に上げた。固定の値は、印の版を上げた後の値に置き換えた（意図した変化。
//   今までの承認はすべて再承認になる。Task 30 の設計書 2 章のユーザーの判断 4）。固定の値は、項目の値の作り方が変わらないことの確かめに使う。
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_DIGEST_ITEMS,
  approvalDigestDifferencesOf,
  approvalDigestEntriesOf,
  computeApprovalDigest,
  type ApprovalDigestFacts,
} from '../../src/control/approval/approval-digest.js';
import { AUTH_SETUP_DIGEST, FULL_VERIFICATION, INPUT_RULES, TARGET_CONFIG_DIGEST, sampleScenario } from './approval-samples.js';

const FACTS: ApprovalDigestFacts = Object.freeze({
  profileRevision: 4,
  authSetupDigest: AUTH_SETUP_DIGEST,
  targetConfigDigest: TARGET_CONFIG_DIGEST,
});

const BASE = sampleScenario();

/**
 * `BASE` と `FACTS` の承認の digest の固定の値（T31b で、印の版 `/3` と UPDATE の指定の 5 項目の後の値に置き換えた（意図した変化。今までの承認は
 * すべて再承認になる）。T30a で固定した版 2 の値は `sha256:507afae414e11d364561252083f6422c76a1b4827afdd0fffa91be8ce4c31903`、T28e で固定した
 * 版 1 の値は `sha256:63aff959e3e6e29a5c00246f1579469ff072bd046b3ee97bb8d0cac4e00dd226`）。
 */
const BASE_DIGEST_BEFORE_ITEMS = 'sha256:f1d363c24e761a844bd54a540f2d39769201813176a94b484b91410eb0f269c0';

describe('approval digest items and differences (T28e)', () => {
  it('lists the items of the digest in the order of the digest, once each', () => {
    expect(APPROVAL_DIGEST_ITEMS).toEqual([
      'profileId',
      'scenarioId',
      'scenarioRevision',
      'profileRevision',
      'authSetupDigest',
      'targetConfigDigest',
      'kind',
      'candidateIdentityDigest',
      'candidateRuleDigest',
      'request',
      'fieldNames',
      'sideEffectConfirmations',
      'limits',
      'approvalTtlDays',
      'inputRuleReference',
      'readChecks',
      'verificationSuccessCondition',
      'verificationInputErrorCondition',
      'verificationRecordId',
      'verificationRead',
      // T31b: UPDATE の指定。
      'updateTargetCreateScenarioId',
      'updateFormPathTemplate',
      'updateActionPathTemplate',
      'updateKeepFieldNames',
      'updateTemplatedIdentityDigest',
    ]);
    expect(Object.isFrozen(APPROVAL_DIGEST_ITEMS)).toBe(true);
  });

  it('keeps the digest value of the same content (fixed value)', () => {
    expect(computeApprovalDigest(BASE, FACTS)).toBe(BASE_DIGEST_BEFORE_ITEMS);
  });

  it('gives the values of the digest by item, sorted where the order does not matter, and frozen', () => {
    const entries = approvalDigestEntriesOf(sampleScenario({ fieldNames: ['name', 'email'] }), FACTS);
    expect(Object.keys(entries)).toEqual([...APPROVAL_DIGEST_ITEMS]);
    expect(entries.fieldNames).toEqual(['email', 'name']);
    expect(entries.request).toEqual(['POST', null, BASE.request.origin, BASE.request.path, BASE.request.enctype]);
    expect(entries.sideEffectConfirmations).toEqual([true, true, true, true]);
    expect(entries.limits).toEqual([1, 20]);
    expect(entries.inputRuleReference).toEqual([INPUT_RULES.ruleSetId, INPUT_RULES.revision, INPUT_RULES.digest]);
    expect(entries.readChecks).toEqual(['["rc-1",2]']);
    expect(entries.verificationSuccessCondition).toEqual(['/members/', '.registered']);
    expect(entries.verificationInputErrorCondition).toEqual(['/members/new', '.error']);
    expect(entries.verificationRecordId).toEqual(['URL_PATH_PATTERN', '/members/{id}']);
    expect(entries.verificationRead).toEqual(['rc-1', 2, ['["q","name"]'], ['["ROW_COUNT_EQUALS",1]', '["TEXT_CONTAINS","email"]']]);
    expect(Object.isFrozen(entries)).toBe(true);
    expect(Object.isFrozen(entries.fieldNames)).toBe(true);
  });

  it('returns no difference for the same content in another order', () => {
    const reordered = sampleScenario({ fieldNames: ['name', 'email'] });
    expect(approvalDigestDifferencesOf({ scenario: BASE, facts: FACTS }, { scenario: reordered, facts: { ...FACTS } })).toEqual([]);
  });

  it('returns the changed items in the order of the digest, with the previous and the current values', () => {
    const current = sampleScenario({
      revision: 4,
      fieldNames: ['email', 'name', 'plan'],
      limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 10 },
      inputRuleReference: null,
    });
    const differences = approvalDigestDifferencesOf(
      { scenario: BASE, facts: FACTS },
      { scenario: current, facts: { ...FACTS, profileRevision: 5, authSetupDigest: null } },
    );
    expect(differences).toEqual([
      { item: 'scenarioRevision', previous: 3, current: 4 },
      { item: 'profileRevision', previous: 4, current: 5 },
      { item: 'authSetupDigest', previous: AUTH_SETUP_DIGEST, current: null },
      { item: 'fieldNames', previous: ['email', 'name'], current: ['email', 'name', 'plan'] },
      { item: 'limits', previous: [1, 20], current: [1, 10] },
      { item: 'inputRuleReference', previous: [INPUT_RULES.ruleSetId, INPUT_RULES.revision, INPUT_RULES.digest], current: null },
    ]);
    expect(Object.isFrozen(differences)).toBe(true);
  });

  it('returns the verification items that changed (T30a)', () => {
    const current = sampleScenario({ verification: { ...FULL_VERIFICATION, successCondition: null, recordId: { source: 'ELEMENT', selector: '#id' } } });
    expect(approvalDigestDifferencesOf({ scenario: BASE, facts: FACTS }, { scenario: current, facts: FACTS })).toEqual([
      { item: 'verificationSuccessCondition', previous: ['/members/', '.registered'], current: null },
      { item: 'verificationRecordId', previous: ['URL_PATH_PATTERN', '/members/{id}'], current: ['ELEMENT', '#id'] },
    ]);
  });

  it('has a difference for every item of the digest that changes the digest', () => {
    const current = sampleScenario({ sideEffectConfirmations: { ...BASE.sideEffectConfirmations, NOT_DESTRUCTIVE: false } });
    expect(approvalDigestDifferencesOf({ scenario: BASE, facts: FACTS }, { scenario: current, facts: FACTS }).map(({ item }) => item))
      .toEqual(['sideEffectConfirmations']);
    expect(computeApprovalDigest(current, FACTS)).not.toBe(computeApprovalDigest(BASE, FACTS));
  });
});
