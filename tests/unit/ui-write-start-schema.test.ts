// T30g fix round 1: 画面の書き込みの開始の Server Function の入力のスキーマ（`schemas/control/ui-write-start.schema.json`）。
// - シナリオの id と、画面が読んだシナリオの版だけ（余分な項目、id の形の違い、版の最小の違いは拒む）。値・資格情報・トークンの項目を持たない。
import { describe, expect, it } from 'vitest';
import { CONTROL_SCHEMA_NAMES, validateControlDocument } from '../../src/control/control-schema-validator.js';

describe('ui-write-start schema (T30g fix round 1)', () => {
  it('is registered as a control schema', () => {
    expect(CONTROL_SCHEMA_NAMES).toContain('ui-write-start');
  });

  it('accepts only a scenario id and the scenario revision the screen read', () => {
    expect(validateControlDocument('ui-write-start', { scenarioId: 'scenario-1', expectedRevision: 1 }).ok).toBe(true);
    for (const value of [
      { scenarioId: 'scenario-1', expectedRevision: 1, extra: true },
      { scenarioId: 'scenario-1' },
      { expectedRevision: 1 },
      { scenarioId: 'Scenario 1', expectedRevision: 1 },
      { scenarioId: 'scenario-1', expectedRevision: 0 },
      { scenarioId: 'scenario-1', expectedRevision: 1.5 },
      { scenarioId: 'scenario-1', expectedRevision: 1, grantId: 'grant-1' },
      null,
    ]) {
      expect(validateControlDocument('ui-write-start', value).ok, JSON.stringify(value)).toBe(false);
    }
  });
});
