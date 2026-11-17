// AUD-8: page の schema の axe の要素の任意の欄（`checks`・`truncations`・`disabledFacts`・`countExclusion`）。新しい記録が通り、古い記録（欄なし）も読め、
// 閉じた一覧の外の値は拒む。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSchemaValidatorRegistry } from '../../src/core/schema-validator.js';

const SCHEMA_ROOT = join(process.cwd(), 'schemas');

const schemaFilesUnder = (directory: string): string[] => readdirSync(directory).flatMap((name) => {
  const path = join(directory, name);
  return statSync(path).isDirectory() ? schemaFilesUnder(path) : name.endsWith('.json') ? [path] : [];
});

const validate = (() => {
  const schemas = schemaFilesUnder(SCHEMA_ROOT).map((path) => JSON.parse(readFileSync(path, 'utf8')) as object);
  const id = 'urn:beaksight:test:aud-8:accessibility-rule';
  return createSchemaValidatorRegistry([...schemas, { $id: id, $ref: 'urn:beaksight:schema:page:1.0#/$defs/accessibilityRule' }]).validatorFor(id);
})();

const OLD_NODE = { impact: 'serious', targetSelectors: ['#t'], failureSummary: null, htmlSnippet: '<p>', truncated: false };
const ruleWith = (node: object) => ({ ruleId: 'color-contrast', impact: 'serious', help: 'h', helpUrl: 'u', tags: [], nodes: [node], omittedNodeCount: 0 });

const NEW_NODE = {
  ...OLD_NODE,
  truncated: true,
  checks: [{ id: 'color-contrast', group: 'any', result: 'UNDETERMINED', messageKey: 'bgImage', data: { fgColor: '#777777', contrastRatio: 4.4, fontWeight: null } }],
  truncations: [{ field: '/htmlSnippet', originalLength: 600, keptLength: 512 }],
  disabledFacts: {
    status: 'READ',
    matchesDisabled: false,
    disabledAttribute: null,
    ariaDisabled: 'ANCESTOR',
    inert: null,
    axDisabled: null,
    pointerEvents: 'auto',
    cursor: 'auto',
    tabIndexNegative: false,
    disabledForAssistiveTech: true,
    disabledStateNotExposed: false,
  },
  countExclusion: 'DISABLED_FOR_ASSISTIVE_TECH',
};

describe('page schema: axe の要素の判定の根拠（AUD-8）', () => {
  it('古い記録（欄なし）と新しい記録が通る', () => {
    expect(validate(ruleWith(OLD_NODE)).ok).toBe(true);
    expect(validate(ruleWith(NEW_NODE)).ok).toBe(true);
    expect(validate(ruleWith({ ...OLD_NODE, disabledFacts: { status: 'NOT_FOUND' }, countExclusion: null })).ok).toBe(true);
    expect(validate(ruleWith({ ...OLD_NODE, disabledFacts: null })).ok).toBe(true);
  });

  it('閉じた一覧の外の値と、許していない形の data を拒む', () => {
    expect(validate(ruleWith({ ...NEW_NODE, countExclusion: 'OTHER' })).ok).toBe(false);
    expect(validate(ruleWith({ ...NEW_NODE, checks: [{ ...NEW_NODE.checks[0], result: 'PASSED' }] })).ok).toBe(false);
    expect(validate(ruleWith({ ...NEW_NODE, checks: [{ ...NEW_NODE.checks[0], data: { nested: { a: 1 } } }] })).ok).toBe(false);
    expect(validate(ruleWith({ ...NEW_NODE, disabledFacts: { status: 'READ' } })).ok).toBe(false);
  });
});
