// T29a（Task 29 の設計書 4.1）: 入力の規則の部品（`src/control/data-rules/`）のテストが共用する例（テストのファイルではない）。
// 例の値は、匿名の値だけを使う（実在の人・会社・宛先を指さない）。
import {
  RULE_SET_SCHEMA_VERSION,
  type FieldRelation,
  type FieldRule,
  type RuleSetRevision,
} from '../../src/control/data-rules/rule-contracts.js';

/** 欄の規則の例（型から作る、範囲なし）。 */
export const sampleFieldRule = (fieldName: string, overrides: Partial<FieldRule> = {}): FieldRule => ({
  fieldName,
  semanticKind: 'GENERIC_NUMBER',
  method: 'FROM_TYPE',
  range: null,
  fixedValues: [],
  ...overrides,
});

/** 欄どうしの関係の例（3 種類を 1 件ずつ）。 */
export const SAMPLE_RELATIONS: readonly FieldRelation[] = Object.freeze([
  { kind: 'END_AFTER_START', startFieldName: 'start_time', endFieldName: 'end_time' },
  { kind: 'TOTAL_EQUALS_UNIT_PRICE_TIMES_QUANTITY', unitPriceFieldName: 'price', quantityFieldName: 'quantity', totalFieldName: 'total' },
  { kind: 'KANA_MATCHES_NAME', nameFieldName: 'name', kanaFieldName: 'name_kana' },
]);

/** 規則の集まりの版の例（関係の欄と一意にする欄は、すべて欄ごとの規則の欄）。 */
export const sampleRuleSet = (overrides: Partial<RuleSetRevision> = {}): RuleSetRevision => ({
  schemaVersion: RULE_SET_SCHEMA_VERSION,
  ruleSetId: 'rules-1',
  scenarioId: 'scenario-1',
  revision: 1,
  fieldRules: [
    sampleFieldRule('name', { semanticKind: 'FULL_NAME', method: 'FROM_TEMPLATE' }),
    sampleFieldRule('name_kana', { semanticKind: 'FULL_NAME_KANA', method: 'FROM_TEMPLATE' }),
    sampleFieldRule('start_time', { semanticKind: 'START_TIME', method: 'FROM_TEMPLATE', range: { min: '09:00', max: '18:00', step: '1800' } }),
    sampleFieldRule('end_time', { semanticKind: 'END_TIME', method: 'FROM_TEMPLATE', range: { min: '09:00', max: '18:00', step: null } }),
    sampleFieldRule('price', { semanticKind: 'UNIT_PRICE', method: 'FROM_TEMPLATE', range: { min: '100', max: '5000', step: '10' } }),
    sampleFieldRule('quantity', { semanticKind: 'QUANTITY', range: { min: '1', max: '10', step: '1' } }),
    sampleFieldRule('total', { semanticKind: 'TOTAL_PRICE', method: 'FROM_TEMPLATE' }),
    sampleFieldRule('course', { semanticKind: 'FIXED_LIST', method: 'FROM_FIXED_LIST', fixedValues: ['a', 'b', 'c'] }),
  ],
  relations: [...SAMPLE_RELATIONS],
  uniqueKeyFieldNames: ['name', 'name_kana'],
  createdAt: '20261013000000',
  ...overrides,
});
