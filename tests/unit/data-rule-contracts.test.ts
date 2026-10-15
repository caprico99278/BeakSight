// T29a（Task 29 の設計書 4.1）: 入力の規則の契約（`src/control/data-rules/rule-contracts.ts`）と、JSON Schema
// （`schemas/control/data-rule.schema.json`）と、保存の前の確かめ直し（`rule-set-policy.ts` の `assertStorableRuleSet`）の検査。
// - 閉じた一覧: 凍結、重なりがない、細分はどのコードの一覧にも 1 回だけ。
// - 合成のメールアドレスと電話番号の形の判定（`example.invalid` だけ、`090-0XXX-XXXX` とハイフンなしの形だけ）。
// - スキーマ: 上限・形・分岐の const と名前つきの定数の一致（enum の一致は `schema-enum-consistency.test.ts`）、受ける形と拒む形。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTROL_SCHEMA_NAMES, validateControlDocument } from '../../src/control/control-schema-validator.js';
import {
  EMAIL_LOCAL_PART_SEPARATOR,
  EXTERNAL_DELIVERY_BLOCKED_DETAILS,
  FIELD_RELATION_KINDS,
  FIELD_RELATION_ROLES,
  FIELD_RULE_STATUSES,
  FIXED_LIST_GENERATION_METHOD,
  GENERATION_METHODS,
  MAX_FIELD_RELATIONS,
  MAX_FIELD_RULES,
  MAX_FIXED_VALUE_LENGTH,
  MAX_FIXED_VALUES,
  MAX_RULE_FIELD_NAME_LENGTH,
  MAX_RULE_RANGE_VALUE_LENGTH,
  MAX_UNIQUE_KEY_FIELDS,
  MAX_UNIQUE_RETRIES,
  MIN_RULE_SET_REVISION,
  NEEDS_RULE_INPUT_DETAILS,
  PHONE_NUMBER_SEPARATOR,
  RULE_CONFLICT_DETAILS,
  RULE_PROBLEM_CODES,
  RULE_PROBLEM_DETAILS,
  RULE_SET_ID_PATTERN,
  RULE_SET_SCHEMA_VERSION,
  RULE_SOURCES,
  SEMANTIC_KINDS,
  SYNTHETIC_EMAIL_DOMAIN,
  SYNTHETIC_PHONE_FORMATS,
  SYNTHETIC_PHONE_MIDDLE_DIGITS,
  SYNTHETIC_PHONE_PATTERNS,
  SYNTHETIC_PHONE_PREFIXES,
  SYNTHETIC_PHONE_VARIABLE_DIGITS,
  isSyntheticEmailAddress,
  relationFieldNamesOf,
  syntheticPhoneFormatOf,
} from '../../src/control/data-rules/rule-contracts.js';
import { assertStorableRuleSet } from '../../src/control/data-rules/rule-set-policy.js';
import { NOT_GENERIC_TYPE } from '../../src/control/data-rules/generic-values.js';
import { SAMPLE_RELATIONS, sampleFieldRule, sampleRuleSet } from './data-rule-samples.js';

type JsonSchema = Record<string, unknown> & {
  readonly properties?: Record<string, JsonSchema>;
  readonly $defs?: Record<string, JsonSchema>;
  readonly items?: JsonSchema;
  readonly anyOf?: readonly JsonSchema[];
  readonly oneOf?: readonly JsonSchema[];
  readonly required?: readonly string[];
};

const schema = JSON.parse(readFileSync(resolve(process.cwd(), 'schemas', 'control', 'data-rule.schema.json'), 'utf8')) as JsonSchema;
const defs = schema.$defs ?? {};
const prop = (node: JsonSchema | undefined, key: string): JsonSchema => node?.properties?.[key] ?? {};

describe('data rule closed lists (T29a)', () => {
  it('freezes every closed list and keeps it without duplicates', () => {
    for (const list of [SEMANTIC_KINDS, GENERATION_METHODS, FIELD_RELATION_KINDS, RULE_PROBLEM_CODES, NEEDS_RULE_INPUT_DETAILS,
      RULE_CONFLICT_DETAILS, EXTERNAL_DELIVERY_BLOCKED_DETAILS, FIELD_RULE_STATUSES, SYNTHETIC_PHONE_FORMATS]) {
      expect(Object.isFrozen(list)).toBe(true);
      expect(new Set<string>(list).size).toBe(list.length);
    }
    for (const table of [FIELD_RELATION_ROLES, RULE_PROBLEM_DETAILS, SYNTHETIC_PHONE_PREFIXES, SYNTHETIC_PHONE_PATTERNS]) {
      expect(Object.isFrozen(table)).toBe(true);
    }
    expect(Object.values(FIELD_RELATION_ROLES).every((roles) => Object.isFrozen(roles))).toBe(true);
  });

  it('has the semantic kinds of the design (with the phone) and the three generation methods', () => {
    expect(SEMANTIC_KINDS).toEqual(expect.arrayContaining([
      'GENERIC_NUMBER', 'GENERIC_DATETIME', 'GENERIC_CHOICE', 'GENERIC_COLOR', 'FAMILY_NAME', 'GIVEN_NAME', 'FULL_NAME', 'FAMILY_NAME_KANA',
      'GIVEN_NAME_KANA', 'FULL_NAME_KANA', 'EMAIL', 'PHONE', 'NOTE', 'PRODUCT_NAME', 'UNIT_PRICE', 'QUANTITY', 'TOTAL_PRICE', 'DATE',
      'START_TIME', 'END_TIME', 'PARTY_SIZE', 'FIXED_LIST', 'OUT_OF_TEMPLATE',
    ]));
    expect(GENERATION_METHODS).toEqual(['FROM_TYPE', 'FROM_TEMPLATE', 'FROM_FIXED_LIST']);
    expect(GENERATION_METHODS).toContain(FIXED_LIST_GENERATION_METHOD);
  });

  it('gives every relation its roles, and no two relations share a role key', () => {
    expect(Object.keys(FIELD_RELATION_ROLES)).toEqual([...FIELD_RELATION_KINDS]);
    const roles = Object.values(FIELD_RELATION_ROLES).flat();
    expect(roles.every((role) => role.endsWith('FieldName'))).toBe(true);
    expect(FIELD_RELATION_ROLES.END_AFTER_START).toEqual(['startFieldName', 'endFieldName']);
    expect(FIELD_RELATION_ROLES.TOTAL_EQUALS_UNIT_PRICE_TIMES_QUANTITY).toEqual(['unitPriceFieldName', 'quantityFieldName', 'totalFieldName']);
    expect(FIELD_RELATION_ROLES.KANA_MATCHES_NAME).toEqual(['nameFieldName', 'kanaFieldName']);
  });

  it('reads the field names of a relation in the order of its roles', () => {
    expect(SAMPLE_RELATIONS.map(relationFieldNamesOf)).toEqual([
      ['start_time', 'end_time'],
      ['price', 'quantity', 'total'],
      ['name', 'name_kana'],
    ]);
    expect(Object.isFrozen(relationFieldNamesOf(SAMPLE_RELATIONS[0] ?? { kind: 'END_AFTER_START', startFieldName: 'a', endFieldName: 'b' })))
      .toBe(true);
  });

  it('lists every detail under exactly one problem code, and the statuses are DECIDED and the problem codes', () => {
    expect(RULE_PROBLEM_CODES).toEqual(['NEEDS_RULE_INPUT', 'RULE_CONFLICT', 'EXTERNAL_DELIVERY_BLOCKED']);
    expect(Object.keys(RULE_PROBLEM_DETAILS)).toEqual([...RULE_PROBLEM_CODES]);
    const details: readonly string[] = Object.values(RULE_PROBLEM_DETAILS).flat();
    expect(new Set(details).size).toBe(details.length);
    expect(details.filter((detail) => (RULE_PROBLEM_CODES as readonly string[]).includes(detail))).toEqual([]);
    expect(RULE_PROBLEM_DETAILS.NEEDS_RULE_INPUT).toEqual(expect.arrayContaining(['NO_RULE', 'REQUIRED_FIELD_NOT_SELECTED', 'URL_FIELD',
      'ADDRESS_FIELD', 'PHONE_FORMAT_UNSUPPORTED']));
    expect(RULE_PROBLEM_DETAILS.RULE_CONFLICT).toEqual(expect.arrayContaining(['UNIQUE_COMBINATIONS_EXHAUSTED', 'NOTIFICATION_OPT_OUT_UNAVAILABLE',
      'FIELD_NOT_SENDABLE']));
    // T29c（指示書の判断 1）: 汎用の規則の理由は、契約の細分（`NOT_GENERIC_TYPE` は細分ではない）。
    expect(RULE_PROBLEM_DETAILS.NEEDS_RULE_INPUT).toEqual(expect.arrayContaining(['RANGE_MISSING', 'RANGE_EMPTY', 'CONSTRAINT_UNSUPPORTED',
      'NO_USABLE_OPTION']));
    expect(details).not.toContain(NOT_GENERIC_TYPE);
    expect(RULE_SOURCES).toEqual(['HUMAN', 'TEMPLATE', 'GENERIC', 'OPT_OUT']);
    expect(Object.isFrozen(RULE_SOURCES)).toBe(true);
    expect(RULE_PROBLEM_DETAILS.EXTERNAL_DELIVERY_BLOCKED).toEqual(['EXTERNAL_NOTIFICATION_UNCONFIRMED']);
    expect(FIELD_RULE_STATUSES).toEqual(['DECIDED', ...RULE_PROBLEM_CODES]);
  });

  it('names the limits (the unique retries are a positive bound)', () => {
    expect(Number.isSafeInteger(MAX_UNIQUE_RETRIES) && MAX_UNIQUE_RETRIES > 0).toBe(true);
    for (const limit of [MAX_FIELD_RULES, MAX_FIELD_RELATIONS, MAX_UNIQUE_KEY_FIELDS, MAX_FIXED_VALUES, MAX_FIXED_VALUE_LENGTH,
      MAX_RULE_RANGE_VALUE_LENGTH, MAX_RULE_FIELD_NAME_LENGTH]) {
      expect(Number.isSafeInteger(limit) && limit > 0).toBe(true);
    }
  });
});

describe('synthetic email addresses and phone numbers (T29a)', () => {
  it('keeps the reserved domain and the phone shapes as named constants', () => {
    expect(SYNTHETIC_EMAIL_DOMAIN).toBe('example.invalid');
    expect(SYNTHETIC_PHONE_PREFIXES).toEqual({ HYPHENATED: '090-0', COMPACT: '0900' });
    expect(SYNTHETIC_PHONE_VARIABLE_DIGITS).toBe(7);
    expect(SYNTHETIC_PHONE_MIDDLE_DIGITS).toBeLessThan(SYNTHETIC_PHONE_VARIABLE_DIGITS);
    // 形（正規表現）と、頭・桁の数の名前つきの定数が合う。
    const digits = '1'.repeat(SYNTHETIC_PHONE_VARIABLE_DIGITS);
    const hyphenated = `${SYNTHETIC_PHONE_PREFIXES.HYPHENATED}${digits.slice(0, SYNTHETIC_PHONE_MIDDLE_DIGITS)}${PHONE_NUMBER_SEPARATOR}`
      + digits.slice(SYNTHETIC_PHONE_MIDDLE_DIGITS);
    expect(syntheticPhoneFormatOf(hyphenated)).toBe('HYPHENATED');
    expect(syntheticPhoneFormatOf(`${SYNTHETIC_PHONE_PREFIXES.COMPACT}${digits}`)).toBe('COMPACT');
    expect(isSyntheticEmailAddress(`a${EMAIL_LOCAL_PART_SEPARATOR}${SYNTHETIC_EMAIL_DOMAIN}`)).toBe(true);
  });

  it.each<readonly [string, string | null]>([
    ['090-0123-4567', 'HYPHENATED'],
    ['090-0000-0000', 'HYPHENATED'],
    ['09001234567', 'COMPACT'],
    ['090-1234-5678', null],
    ['09012345678', null],
    ['080-0123-4567', null],
    ['090-0123-456', null],
    ['090-01234-567', null],
    ['0900123456', null],
    ['090012345678', null],
    ['090-0123-4567\n', null],
    ['０９０-０１２３-４５６７', null],
    ['', null],
  ])('reads the phone shape of %j as %s', (value, format) => {
    expect(syntheticPhoneFormatOf(value)).toBe(format);
  });

  it.each<readonly [string, boolean]>([
    ['a1@example.invalid', true],
    ['sato.hanako_01@example.invalid', true],
    ['a@example.invalid', true],
    ['a@example.com', false],
    ['a@sub.example.invalid', false],
    ['a@EXAMPLE.INVALID', false],
    ['@example.invalid', false],
    ['a@b@example.invalid', false],
    ['.a@example.invalid', false],
    ['a.@example.invalid', false],
    ['A@example.invalid', false],
    ['a b@example.invalid', false],
    ['a@example.invalid ', false],
    [`${'a'.repeat(65)}@example.invalid`, false],
    [`${'a'.repeat(64)}@example.invalid`, true],
  ])('reads %j as a synthetic email address: %s', (value, expected) => {
    expect(isSyntheticEmailAddress(value)).toBe(expected);
  });
});

describe('data rule schema (T29a)', () => {
  it('is registered in the control schema names', () => {
    expect(CONTROL_SCHEMA_NAMES).toContain('data-rule');
    expect(schema.$id).toBe('urn:beaksight:schema:control:data-rule:1');
  });

  it('matches the limits, shapes and branch constants with the named constants', () => {
    expect(prop(schema, 'schemaVersion').const).toBe(RULE_SET_SCHEMA_VERSION);
    expect(prop(schema, 'ruleSetId').pattern).toBe(RULE_SET_ID_PATTERN.source);
    expect(prop(schema, 'scenarioId').pattern).toBe(RULE_SET_ID_PATTERN.source);
    expect(prop(schema, 'revision').minimum).toBe(MIN_RULE_SET_REVISION);
    expect(prop(schema, 'fieldRules').maxItems).toBe(MAX_FIELD_RULES);
    expect(prop(schema, 'relations').maxItems).toBe(MAX_FIELD_RELATIONS);
    expect(prop(schema, 'uniqueKeyFieldNames').maxItems).toBe(MAX_UNIQUE_KEY_FIELDS);
    expect(defs.fieldName?.maxLength).toBe(MAX_RULE_FIELD_NAME_LENGTH);
    expect(defs.rangeValue?.maxLength).toBe(MAX_RULE_RANGE_VALUE_LENGTH);
    const fixedValues = prop(defs.fieldRule, 'fixedValues');
    expect(fixedValues.maxItems).toBe(MAX_FIXED_VALUES);
    expect(fixedValues.items?.maxLength).toBe(MAX_FIXED_VALUE_LENGTH);
    expect((defs.fieldRule?.if as JsonSchema | undefined)?.properties?.method?.const).toBe(FIXED_LIST_GENERATION_METHOD);
    expect(Object.keys(defs.range?.properties ?? {})).toEqual(['min', 'max', 'step']);
    const branches = (defs.relation?.oneOf ?? []).map((branch) => defs[String(branch.$ref).replace('#/$defs/', '')]);
    expect(branches.map((branch) => prop(branch, 'kind').const)).toEqual([...FIELD_RELATION_KINDS]);
    for (const [index, kind] of FIELD_RELATION_KINDS.entries()) {
      expect(branches[index]?.required).toEqual(['kind', ...FIELD_RELATION_ROLES[kind]]);
      expect(Object.keys(branches[index]?.properties ?? {})).toEqual(['kind', ...FIELD_RELATION_ROLES[kind]]);
    }
  });

  it('accepts the examples of the contract', () => {
    expect(validateControlDocument('data-rule', sampleRuleSet())).toEqual({ ok: true });
    expect(validateControlDocument('data-rule', sampleRuleSet({ fieldRules: [], relations: [], uniqueKeyFieldNames: [] }))).toEqual({ ok: true });
    expect(validateControlDocument('data-rule', sampleRuleSet({
      fieldRules: [sampleFieldRule('phone', { semanticKind: 'PHONE', method: 'FROM_FIXED_LIST', fixedValues: ['090-0000-0001'] })],
      relations: [],
      uniqueKeyFieldNames: ['phone'],
    }))).toEqual({ ok: true });
  });

  it.each<readonly [string, unknown]>([
    ['an unknown semantic kind', sampleRuleSet({ fieldRules: [sampleFieldRule('a', { semanticKind: 'ADDRESS' as never })] })],
    ['an unknown method', sampleRuleSet({ fieldRules: [sampleFieldRule('a', { method: 'FROM_LLM' as never })] })],
    ['a fixed list without values', sampleRuleSet({ fieldRules: [sampleFieldRule('a', { method: 'FROM_FIXED_LIST', fixedValues: [] })] })],
    ['fixed values of another method', sampleRuleSet({ fieldRules: [sampleFieldRule('a', { method: 'FROM_TYPE', fixedValues: ['1'] })] })],
    ['duplicate fixed values', sampleRuleSet({ fieldRules: [sampleFieldRule('a', { method: 'FROM_FIXED_LIST', fixedValues: ['1', '1'] })] })],
    ['an empty fixed value', sampleRuleSet({ fieldRules: [sampleFieldRule('a', { method: 'FROM_FIXED_LIST', fixedValues: [''] })] })],
    ['too many fixed values', sampleRuleSet({ fieldRules: [sampleFieldRule('a', {
      method: 'FROM_FIXED_LIST', fixedValues: Array.from({ length: MAX_FIXED_VALUES + 1 }, (_value, index) => String(index)),
    })] })],
    ['a too long fixed value', sampleRuleSet({ fieldRules: [sampleFieldRule('a', {
      method: 'FROM_FIXED_LIST', fixedValues: ['x'.repeat(MAX_FIXED_VALUE_LENGTH + 1)],
    })] })],
    ['an empty field name', sampleRuleSet({ fieldRules: [sampleFieldRule('')] })],
    ['a partial range', sampleRuleSet({ fieldRules: [sampleFieldRule('a', { range: { min: '1', max: '2' } as never })] })],
    ['a numeric range value', sampleRuleSet({ fieldRules: [sampleFieldRule('a', { range: { min: 1, max: null, step: null } as never })] })],
    ['a value property', { ...sampleRuleSet(), values: { a: '1' } }],
    ['a relation of an unknown kind', sampleRuleSet({ relations: [{ kind: 'SAME_AS', nameFieldName: 'a', kanaFieldName: 'b' } as never] })],
    ['a relation with a missing role', sampleRuleSet({ relations: [{ kind: 'END_AFTER_START', startFieldName: 'a' } as never] })],
    ['a relation with a role of another kind', sampleRuleSet({
      relations: [{ kind: 'END_AFTER_START', startFieldName: 'a', endFieldName: 'b', totalFieldName: 'c' } as never],
    })],
    ['a duplicate unique key field', sampleRuleSet({ uniqueKeyFieldNames: ['name', 'name'] })],
    ['a bad rule set id', sampleRuleSet({ ruleSetId: 'Rules_1' })],
    ['a revision of 0', sampleRuleSet({ revision: 0 })],
    ['a bad timestamp', sampleRuleSet({ createdAt: '2026-10-13' })],
    ['another schema version', sampleRuleSet({ schemaVersion: 'beaksight-data-rule/2' as never })],
  ])('rejects a rule set with %s', (_label, document) => {
    expect(validateControlDocument('data-rule', document).ok).toBe(false);
  });
});

describe('ui-data-rule-save schema (T29e)', () => {
  const input = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
    const { fieldRules, relations, uniqueKeyFieldNames } = sampleRuleSet();
    return { scenarioId: 'scenario-1', expectedScenarioRevision: 2, expectedRuleSetRevision: null, fieldRules, relations, uniqueKeyFieldNames, ...overrides };
  };

  it('accepts the content of a rule set with the revisions the screen read', () => {
    expect(validateControlDocument('ui-data-rule-save', input())).toEqual({ ok: true });
    expect(validateControlDocument('ui-data-rule-save', input({ expectedRuleSetRevision: 3, fieldRules: [], relations: [], uniqueKeyFieldNames: [] })))
      .toEqual({ ok: true });
  });

  it.each<readonly [string, Record<string, unknown>]>([
    ['an extra property', input({ ruleSetId: 'rules-1' })],
    ['a bad scenario id', input({ scenarioId: '../x' })],
    ['a revision of 0', input({ expectedScenarioRevision: 0 })],
    ['a rule set revision of 0', input({ expectedRuleSetRevision: 0 })],
    ['an unknown semantic kind', input({ fieldRules: [sampleFieldRule('a', { semanticKind: 'ADDRESS' as never })] })],
    ['fixed values of another method', input({ fieldRules: [sampleFieldRule('a', { fixedValues: ['1'] })] })],
    ['a relation of an unknown kind', input({ relations: [{ kind: 'SAME_AS' }] })],
    ['a missing content', (({ fieldRules: _omitted, ...rest }) => rest)(input())],
  ])('rejects %s', (_label, document) => {
    expect(validateControlDocument('ui-data-rule-save', document).ok).toBe(false);
  });
});

describe('assertStorableRuleSet (T29a)', () => {
  it('returns a frozen copy that matches the contract', () => {
    const original = sampleRuleSet();
    const stored = assertStorableRuleSet(original);
    expect(stored).toEqual(original);
    expect(stored).not.toBe(original);
    expect(Object.isFrozen(stored) && Object.isFrozen(stored.fieldRules) && Object.isFrozen(stored.fieldRules[0])
      && Object.isFrozen(stored.relations[0])).toBe(true);
    expect(Object.isFrozen(original)).toBe(false);
  });

  it.each<readonly [string, unknown]>([
    ['a schema violation', sampleRuleSet({ revision: 0 })],
    ['a duplicate field rule', sampleRuleSet({ fieldRules: [...sampleRuleSet().fieldRules, sampleFieldRule('name')] })],
    ['a relation of a field without a rule', sampleRuleSet({
      relations: [{ kind: 'END_AFTER_START', startFieldName: 'start_time', endFieldName: 'missing' }],
    })],
    ['a unique key field without a rule', sampleRuleSet({ uniqueKeyFieldNames: ['name', 'missing'] })],
  ])('throws RangeError on %s', (_label, document) => {
    expect(() => assertStorableRuleSet(document as never)).toThrow(RangeError);
  });
});
