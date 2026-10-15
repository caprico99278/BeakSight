// T29a（Task 29 の設計書 3 章、4.1）: 規則の集まりの digest（`src/control/data-rules/rule-digest.ts`）の検査。
// - 形は Task 28 の入力の規則の参照の digest と同じ `sha256:<16進64桁>`。同じ内容は同じ値。
// - 各項目（id、シナリオの id、欄ごとの規則の各項目、関係、一意にする欄の組）の変化で変わる。版と作成の時刻では変わらない。
// - 並びの順に依らない所（欄ごとの規則、関係、一意にする欄の組）は並べてから求める。固定の値の一覧の並びは意味を持つ（変われば変わる）。
import { describe, expect, it } from 'vitest';
import { createSha256Fingerprint, isSha256Fingerprint } from '../../src/core/ids.js';
import { sortedKeysJsonOf } from '../../src/core/sorted-keys-json.js';
import {
  RULE_SET_DIGEST_FORMAT,
  computeRuleSetDigest,
  inputRuleReferenceOf,
  ruleSetDigestInputOf,
} from '../../src/control/data-rules/rule-digest.js';
import type { FieldRule, RuleSetRevision } from '../../src/control/data-rules/rule-contracts.js';
import { sampleFieldRule, sampleRuleSet } from './data-rule-samples.js';

const BASE = computeRuleSetDigest(sampleRuleSet());

/** 欄ごとの規則の 1 件目だけを変えた規則の集まり。 */
const withFirstRule = (overrides: Partial<FieldRule>): RuleSetRevision => {
  const [first, ...rest] = sampleRuleSet().fieldRules;
  return sampleRuleSet({ fieldRules: [{ ...(first ?? sampleFieldRule('x')), ...overrides }, ...rest] });
};

describe('rule set digest (T29a)', () => {
  it('is a sha256 fingerprint of the sorted-keys JSON with the format marker', () => {
    expect(isSha256Fingerprint(BASE)).toBe(true);
    expect(BASE).toBe(createSha256Fingerprint(sortedKeysJsonOf(ruleSetDigestInputOf(sampleRuleSet()))));
    expect(ruleSetDigestInputOf(sampleRuleSet()).format).toBe(RULE_SET_DIGEST_FORMAT);
    expect(Object.isFrozen(ruleSetDigestInputOf(sampleRuleSet()))).toBe(true);
  });

  it('gives the same value for the same content, and does not change the input', () => {
    const ruleSet = sampleRuleSet();
    const before = JSON.stringify(ruleSet);
    expect(computeRuleSetDigest(ruleSet)).toBe(BASE);
    expect(computeRuleSetDigest(structuredClone(ruleSet))).toBe(BASE);
    expect(JSON.stringify(ruleSet)).toBe(before);
  });

  it('does not change with the revision or the creation time (the reference carries the revision)', () => {
    expect(computeRuleSetDigest(sampleRuleSet({ revision: 2 }))).toBe(BASE);
    expect(computeRuleSetDigest(sampleRuleSet({ createdAt: '20261014000000' }))).toBe(BASE);
  });

  it.each<readonly [string, RuleSetRevision]>([
    ['the rule set id', sampleRuleSet({ ruleSetId: 'rules-2' })],
    ['the scenario id', sampleRuleSet({ scenarioId: 'scenario-2' })],
    ['a field name', withFirstRule({ fieldName: 'full_name' })],
    ['a semantic kind', withFirstRule({ semanticKind: 'FAMILY_NAME' })],
    ['a method', withFirstRule({ method: 'FROM_TYPE' })],
    ['a range', withFirstRule({ range: { min: '1', max: null, step: null } })],
    ['a range bound', sampleRuleSet({ fieldRules: sampleRuleSet().fieldRules.map((rule) => (rule.fieldName === 'price'
      ? { ...rule, range: { min: '100', max: '6000', step: '10' } }
      : rule)) })],
    ['a fixed value', sampleRuleSet({ fieldRules: sampleRuleSet().fieldRules.map((rule) => (rule.fieldName === 'course'
      ? { ...rule, fixedValues: ['a', 'b', 'd'] }
      : rule)) })],
    ['the order of the fixed values', sampleRuleSet({ fieldRules: sampleRuleSet().fieldRules.map((rule) => (rule.fieldName === 'course'
      ? { ...rule, fixedValues: ['c', 'b', 'a'] }
      : rule)) })],
    ['an added field rule', sampleRuleSet({ fieldRules: [...sampleRuleSet().fieldRules, sampleFieldRule('people')] })],
    ['a removed relation', sampleRuleSet({ relations: sampleRuleSet().relations.slice(1) })],
    ['a relation role', sampleRuleSet({ relations: [{ kind: 'END_AFTER_START', startFieldName: 'end_time', endFieldName: 'start_time' }] })],
    ['the unique key fields', sampleRuleSet({ uniqueKeyFieldNames: ['name'] })],
  ])('changes with %s', (_label, ruleSet) => {
    expect(computeRuleSetDigest(ruleSet)).not.toBe(BASE);
  });

  it('does not depend on the order of the field rules, the relations, the unique key fields or the object keys', () => {
    const sample = sampleRuleSet();
    expect(computeRuleSetDigest(sampleRuleSet({
      fieldRules: [...sample.fieldRules].reverse(),
      relations: [...sample.relations].reverse(),
      uniqueKeyFieldNames: [...sample.uniqueKeyFieldNames].reverse(),
    }))).toBe(BASE);
    const reordered = sample.fieldRules.map((rule) => ({
      fixedValues: rule.fixedValues, range: rule.range, method: rule.method, semanticKind: rule.semanticKind, fieldName: rule.fieldName,
    }));
    expect(computeRuleSetDigest(sampleRuleSet({ fieldRules: reordered }))).toBe(BASE);
  });

  it('ignores properties outside the contract (it reads only the digest items)', () => {
    const extra = { ...sampleRuleSet(), note: 'x', fieldRules: sampleRuleSet().fieldRules.map((rule) => ({ ...rule, label: 'x' })) };
    expect(computeRuleSetDigest(extra as RuleSetRevision)).toBe(BASE);
  });

  it('builds the input rule reference of Task 28 (id, revision and digest)', () => {
    const reference = inputRuleReferenceOf(sampleRuleSet({ revision: 3 }));
    expect(reference).toEqual({ ruleSetId: 'rules-1', revision: 3, digest: BASE });
    expect(Object.isFrozen(reference)).toBe(true);
  });
});
