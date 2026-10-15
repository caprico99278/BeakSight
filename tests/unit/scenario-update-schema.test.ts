// T31b（Task 31 の設計書 3 章の「UPDATE の指定」、11 章の T31b の Blocker の判断の 4）: シナリオの版のスキーマ（`schemas/control/scenario.schema.json`）
// の UPDATE の指定と、契約（`scenario-contracts.ts`）の名前つきの定数の一致。
// - `update` は必須の項目。CREATE は null だけ。UPDATE は指定か null（UPDATE の指定の前に保存した版。読めるが承認と発行はできない）。
// - 保存した版を読むとき（`storedScenarioRevisionOf`）、`update` の項目がない版は null として読む。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_SCENARIO_KEEP_FIELD_NAMES,
  MAX_UPDATE_PATH_TEMPLATE_LENGTH,
  SCENARIO_ID_PATTERN,
} from '../../src/control/approval/scenario-contracts.js';
import { assertStorableScenarioRevision, storedScenarioRevisionOf } from '../../src/control/approval/scenario-policy.js';
import { MAX_FIELD_NAME_LENGTH } from '../../src/discovery/candidate-contracts.js';
import { UPDATE_SPEC, sampleScenario, sampleUpdateScenario } from './approval-samples.js';

type JsonSchema = Record<string, unknown> & {
  readonly properties?: Record<string, JsonSchema>;
  readonly $defs?: Record<string, JsonSchema>;
  readonly items?: JsonSchema;
  readonly required?: readonly string[];
};

const schema = JSON.parse(readFileSync(resolve(process.cwd(), 'schemas', 'control', 'scenario.schema.json'), 'utf8')) as JsonSchema;
const updateDef = schema.$defs?.update;
const prop = (node: JsonSchema | undefined, key: string): JsonSchema => node?.properties?.[key] ?? {};

/** 項目を除いた写し（保存した版の古い形）。 */
const withoutUpdate = (document: object): Record<string, unknown> => {
  const { update: _omitted, ...rest } = document as Record<string, unknown>;
  return rest;
};

describe('UPDATE spec in the scenario schema (T31b)', () => {
  it('requires the update item and matches the limits and shapes with the named constants', () => {
    expect(schema.required).toContain('update');
    expect(updateDef?.required).toEqual(['targetCreateScenarioId', 'formPathTemplate', 'actionPathTemplate', 'keepFieldNames', 'templatedIdentityDigest']);
    expect(updateDef?.additionalProperties).toBe(false);
    expect(prop(updateDef, 'targetCreateScenarioId').pattern).toBe(SCENARIO_ID_PATTERN.source);
    expect(prop(updateDef, 'formPathTemplate').maxLength).toBe(MAX_UPDATE_PATH_TEMPLATE_LENGTH);
    expect(prop(updateDef, 'actionPathTemplate').maxLength).toBe(MAX_UPDATE_PATH_TEMPLATE_LENGTH);
    expect(prop(updateDef, 'keepFieldNames').maxItems).toBe(MAX_SCENARIO_KEEP_FIELD_NAMES);
    expect(prop(updateDef, 'keepFieldNames').items?.maxLength).toBe(MAX_FIELD_NAME_LENGTH);
  });

  it('accepts a CREATE revision only with a null spec, and an UPDATE revision with a spec or null', () => {
    expect(assertStorableScenarioRevision(sampleScenario()).update).toBeNull();
    expect(() => assertStorableScenarioRevision(sampleScenario({ update: UPDATE_SPEC }))).toThrow(RangeError);
    expect(assertStorableScenarioRevision(sampleUpdateScenario()).update).toEqual(UPDATE_SPEC);
    expect(assertStorableScenarioRevision(sampleUpdateScenario({ update: null })).update).toBeNull();
    expect(() => assertStorableScenarioRevision(withoutUpdate(sampleScenario()) as never)).toThrow(RangeError);
  });

  it.each([
    ['an unknown property', { ...UPDATE_SPEC, extra: 1 }],
    ['a target id of another form', { ...UPDATE_SPEC, targetCreateScenarioId: 'Scenario' }],
    ['a template without a leading slash', { ...UPDATE_SPEC, formPathTemplate: 'members/{id}' }],
    ['a duplicate keep field', { ...UPDATE_SPEC, keepFieldNames: ['a', 'a'] }],
    ['a templated digest of another form', { ...UPDATE_SPEC, templatedIdentityDigest: 'sha256:abc' }],
  ])('rejects a spec of another shape (%s)', (_label, update) => {
    expect(() => assertStorableScenarioRevision(sampleUpdateScenario({ update: update as never }))).toThrow(RangeError);
  });

  it('reads a stored revision without the update item as a revision without the spec', () => {
    expect(storedScenarioRevisionOf(withoutUpdate(sampleScenario())).update).toBeNull();
    expect(storedScenarioRevisionOf(withoutUpdate(sampleUpdateScenario())).update).toBeNull();
    expect(storedScenarioRevisionOf(sampleUpdateScenario()).update).toEqual(UPDATE_SPEC);
  });
});
