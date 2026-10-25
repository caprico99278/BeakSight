// FM2c（手動の操作を減らす設計書 3A.3）: 規則の集まりの版 2（出どころの印 `origin`、基準日からの幅 `baseDateWindow`、「番号・コード」の種類）と、
// digest の形の版 2。
// - スキーマ: 版 2 は `schemas/control/data-rule-v2.schema.json`。
// - 読み方（`ruleSetRevisionOfStoredDocument`）: 版 2 の文書だけを読む。LG-3（2026-10-24 の設計 3.7.2）: 版 1 の文書と digest の形の版 1 は捨てた
//   （版 1 の文書は読み替えずに誤り。保存の部品は `DATABASE_INTEGRITY_FAILED`）。
// - digest: 版 2 の形（欄の規則に出どころと基準日からの幅を入れる）。印がない規則は人の規則と同じ値（同じ意味は同じ digest）。
import { describe, expect, it } from 'vitest';
import { validateControlDocument } from '../../src/control/control-schema-validator.js';
import {
  RULE_ORIGINS,
  RULE_SET_SCHEMA_VERSION,
  SEMANTIC_KINDS,
  type FieldRelation,
  type FieldRule,
  type RuleSetRevision,
} from '../../src/control/data-rules/rule-contracts.js';
import {
  RULE_SET_DIGEST_FIELD_RULE_ITEMS,
  RULE_SET_DIGEST_FORMAT,
  RULE_SET_DIGEST_ITEMS,
  computeRuleSetDigest,
  ruleSetDigestInputOf,
} from '../../src/control/data-rules/rule-digest.js';
import { assertStorableRuleSet, ruleSetRevisionOfStoredDocument } from '../../src/control/data-rules/rule-set-policy.js';
import { sampleFieldRule, sampleRuleSet } from './data-rule-samples.js';

/** 捨てた版 1 の文書の印（LG-3。前の形の行が誤りになることの確かめにだけ使う）。 */
const REMOVED_VERSION_1 = 'beaksight-data-rule/1';

/** 版 1 の文書（版 1 の項目だけ）。 */
const v1Document = (): Record<string, unknown> => ({ ...sampleRuleSet(), schemaVersion: REMOVED_VERSION_1 });

const INFERRED_WINDOW_RULE: FieldRule = {
  fieldName: 'visit', semanticKind: 'GENERIC_DATETIME', method: 'FROM_TYPE', range: null, fixedValues: [], origin: 'INFERRED',
  baseDateWindow: { fromDays: 0, toDays: 30 },
};

const withRules = (fieldRules: readonly FieldRule[]): RuleSetRevision =>
  sampleRuleSet({ fieldRules: [...fieldRules], relations: [], uniqueKeyFieldNames: [] });

/** 関係の印の検査に使う、開始と終了の規則と関係（fix round 1）。 */
const RELATION_RULES: readonly FieldRule[] = [
  sampleFieldRule('s', { semanticKind: 'START_TIME', method: 'FROM_TEMPLATE' }),
  sampleFieldRule('e', { semanticKind: 'END_TIME', method: 'FROM_TEMPLATE' }),
];
const START_END: FieldRelation = { kind: 'END_AFTER_START', startFieldName: 's', endFieldName: 'e' };

describe('FM2c: the rule set document version 2', () => {
  it('is the version 2 for the new documents, and the origin is a closed list', () => {
    expect(RULE_SET_SCHEMA_VERSION).toBe('beaksight-data-rule/2');
    expect(RULE_ORIGINS).toEqual(['HUMAN', 'INFERRED']);
    expect(SEMANTIC_KINDS).toContain('DIGIT_CODE');
  });

  it('accepts the origin, the base date window and the digit code kind in the version 2 schema', () => {
    const document = withRules([INFERRED_WINDOW_RULE, sampleFieldRule('code', { semanticKind: 'DIGIT_CODE', method: 'FROM_TEMPLATE', origin: 'HUMAN' })]);
    expect(validateControlDocument('data-rule-v2', document)).toEqual({ ok: true });
    expect(validateControlDocument('data-rule-v2', sampleRuleSet())).toEqual({ ok: true });
    expect(validateControlDocument('data-rule-v2', v1Document()).ok).toBe(false);
  });

  it.each<readonly [string, FieldRule]>([
    ['an inferred fixed list', sampleFieldRule('a', { method: 'FROM_FIXED_LIST', fixedValues: ['1'], origin: 'INFERRED' })],
    ['an unknown origin', sampleFieldRule('a', { origin: 'MACHINE' as never })],
    ['a negative window', { ...INFERRED_WINDOW_RULE, baseDateWindow: { fromDays: -1, toDays: 30 } }],
    ['a window that is not an integer', { ...INFERRED_WINDOW_RULE, baseDateWindow: { fromDays: 0, toDays: 1.5 } }],
    ['a window too long', { ...INFERRED_WINDOW_RULE, baseDateWindow: { fromDays: 0, toDays: 100_000 } }],
    ['a window without the end', { ...INFERRED_WINDOW_RULE, baseDateWindow: { fromDays: 0 } as never }],
    ['a digit count of 0', sampleFieldRule('a', { semanticKind: 'DIGIT_CODE', method: 'FROM_TEMPLATE', digitCount: 0 })],
    ['a digit count too large', sampleFieldRule('a', { semanticKind: 'DIGIT_CODE', method: 'FROM_TEMPLATE', digitCount: 257 })],
  ])('rejects %s in the version 2 schema', (_label, rule) => {
    expect(validateControlDocument('data-rule-v2', withRules([rule])).ok).toBe(false);
  });

  it('accepts the origin marks of the relations and the unique key fields and the mark of the saved defaults', () => {
    const document = { ...withRules(RELATION_RULES), relations: [{ ...START_END, origin: 'INFERRED' }], uniqueKeyFieldNames: ['s'],
      uniqueKeyOrigin: 'INFERRED', templateDefaultsSaved: true };
    expect(validateControlDocument('data-rule-v2', document)).toEqual({ ok: true });
    expect(validateControlDocument('data-rule-v2', { ...document, uniqueKeyOrigin: 'MACHINE' }).ok).toBe(false);
  });

  it('rejects a digit count on a rule that is not the digit code kind, when it is stored', () => {
    expect(() => assertStorableRuleSet(withRules([sampleFieldRule('a', { digitCount: 3 })]))).toThrow(RangeError);
    expect(assertStorableRuleSet(withRules([sampleFieldRule('a', { semanticKind: 'DIGIT_CODE', method: 'FROM_TEMPLATE', digitCount: 3 })]))
      .fieldRules[0]?.digitCount).toBe(3);
  });

  it('rejects a window together with a range, and a window whose start is after its end, when it is stored', () => {
    expect(() => assertStorableRuleSet(withRules([{ ...INFERRED_WINDOW_RULE, range: { min: '2026-01-01', max: null, step: null } }])))
      .toThrow(RangeError);
    expect(() => assertStorableRuleSet(withRules([{ ...INFERRED_WINDOW_RULE, baseDateWindow: { fromDays: 10, toDays: 3 } }]))).toThrow(RangeError);
    expect(assertStorableRuleSet(withRules([INFERRED_WINDOW_RULE])).fieldRules[0]).toEqual(INFERRED_WINDOW_RULE);
  });

  it('stores only the version 2 (a new revision is never written in the version 1)', () => {
    expect(() => assertStorableRuleSet(v1Document() as unknown as RuleSetRevision)).toThrow(RangeError);
  });
});

describe('LG-3: reading the stored documents (one place for the reading rule)', () => {
  it('does not read a version 1 document (it is not converted to a human rule)', () => {
    expect(() => ruleSetRevisionOfStoredDocument(v1Document())).toThrow(RangeError);
  });

  it('reads a version 2 document with its schema, and rejects a document of an unknown version or of a wrong shape', () => {
    const read = ruleSetRevisionOfStoredDocument(withRules([INFERRED_WINDOW_RULE]));
    expect(read.fieldRules[0]).toEqual(INFERRED_WINDOW_RULE);
    expect(Object.isFrozen(read)).toBe(true);
    expect(() => ruleSetRevisionOfStoredDocument({ ...sampleRuleSet(), schemaVersion: 'beaksight-data-rule/9' })).toThrow(RangeError);
    expect(() => ruleSetRevisionOfStoredDocument({ ...sampleRuleSet(), fieldRules: [{ ...INFERRED_WINDOW_RULE, origin: 'MACHINE' }] })).toThrow(RangeError);
    expect(() => ruleSetRevisionOfStoredDocument(null)).toThrow(RangeError);
  });
});

describe('FM2c: the digest form version 2', () => {
  const BASE = computeRuleSetDigest(withRules([INFERRED_WINDOW_RULE]));

  it('is the version 2 form, with the origin and the window in each field rule', () => {
    expect(RULE_SET_DIGEST_FORMAT).toBe('beaksight-data-rule-digest/2');
    expect(RULE_SET_DIGEST_FIELD_RULE_ITEMS).toEqual(
      ['fieldName', 'semanticKind', 'method', 'range', 'fixedValues', 'origin', 'baseDateWindow', 'digitCount'],
    );
    expect(RULE_SET_DIGEST_ITEMS).toEqual(
      ['ruleSetId', 'scenarioId', 'fieldRules', 'relations', 'uniqueKeyFieldNames', 'uniqueKeyOrigin', 'templateDefaultsSaved'],
    );
    const input = ruleSetDigestInputOf(withRules([INFERRED_WINDOW_RULE]));
    expect(input.format).toBe(RULE_SET_DIGEST_FORMAT);
    expect(input.fieldRules[0]).toEqual({ ...INFERRED_WINDOW_RULE, digitCount: null });
    expect(input).toMatchObject({ uniqueKeyOrigin: 'HUMAN', templateDefaultsSaved: false });
  });

  const RELATION_BASE: RuleSetRevision = { ...withRules(RELATION_RULES), relations: [START_END] };
  const CODE_RULE = sampleFieldRule('code', { semanticKind: 'DIGIT_CODE', method: 'FROM_TEMPLATE' });
  const CODE_BASE: RuleSetRevision = { ...RELATION_BASE, fieldRules: [...RELATION_RULES, CODE_RULE] };

  it.each<readonly [string, RuleSetRevision, RuleSetRevision]>([
    ['the origin of a relation', { ...RELATION_BASE, relations: [{ ...START_END, origin: 'INFERRED' }] }, RELATION_BASE],
    ['the origin of the unique key fields', { ...RELATION_BASE, uniqueKeyOrigin: 'INFERRED' }, RELATION_BASE],
    ['the mark of the saved template defaults', { ...RELATION_BASE, templateDefaultsSaved: true }, RELATION_BASE],
    ['the digit count', { ...CODE_BASE, fieldRules: [...RELATION_RULES, { ...CODE_RULE, digitCount: 4 }] }, CODE_BASE],
  ])('changes with %s (fix round 1)', (_label, changed, base) => {
    expect(computeRuleSetDigest(changed)).not.toBe(computeRuleSetDigest(base));
  });

  it('gives the same value to the absent marks and to the marks of the same meaning (fix round 1)', () => {
    expect(computeRuleSetDigest({
      ...RELATION_BASE, relations: [{ ...START_END, origin: 'HUMAN' }], uniqueKeyOrigin: 'HUMAN', templateDefaultsSaved: false,
    })).toBe(computeRuleSetDigest(RELATION_BASE));
  });

  it.each<readonly [string, FieldRule]>([
    ['the origin', { ...INFERRED_WINDOW_RULE, origin: 'HUMAN' }],
    ['the end of the window', { ...INFERRED_WINDOW_RULE, baseDateWindow: { fromDays: 0, toDays: 29 } }],
    ['the start of the window', { ...INFERRED_WINDOW_RULE, baseDateWindow: { fromDays: 1, toDays: 30 } }],
    ['no window', { ...INFERRED_WINDOW_RULE, baseDateWindow: null }],
  ])('changes with %s of an inferred rule (the inferred rules are bound to the approval)', (_label, rule) => {
    expect(computeRuleSetDigest(withRules([rule]))).not.toBe(BASE);
  });

  it('gives the same value to a rule without the marks and to a human rule without a window (the same meaning)', () => {
    const plain = sampleFieldRule('a');
    const explicit: FieldRule = { ...plain, origin: 'HUMAN', baseDateWindow: null };
    expect(computeRuleSetDigest(withRules([plain]))).toBe(computeRuleSetDigest(withRules([explicit])));
  });
});
