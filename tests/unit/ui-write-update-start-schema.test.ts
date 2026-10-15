// T31h-2（Task 31 の設計書 3 章の「対象の選び方」、10 章）: 画面の更新の書き込みの開始の Server Function（`startWriteUpdateFn`）の入力のスキーマ
// （`schemas/control/ui-write-update-start.schema.json`）。
// - シナリオの id と、画面が読んだシナリオの版と、画面が見せた更新の予定のレコードの ID（必須。登録の ID として使える形。発行の中で選び直した ID と
//   照らす）だけ。余分な項目、id の形の違い、版の最小の違い、ID の形の違いは拒む。値・資格情報・トークンの項目を持たない。
// - CREATE の開始の入力（`ui-write-start`）は変えない（予定の ID を持てない）。
import { describe, expect, it } from 'vitest';
import { MAX_SAFE_RECORD_ID_LENGTH } from '../../src/control/actions/action-outcome.js';
import { CONTROL_SCHEMA_NAMES, validateControlDocument } from '../../src/control/control-schema-validator.js';

const VALID = Object.freeze({ scenarioId: 'scenario-1', expectedRevision: 1, expectedTargetRecordId: 'rec_1-a' });

describe('ui-write-update-start schema (T31h-2)', () => {
  it('is registered as a control schema', () => {
    expect(CONTROL_SCHEMA_NAMES).toContain('ui-write-update-start');
  });

  it('accepts a scenario id, the scenario revision and the planned target record id the screen showed', () => {
    expect(validateControlDocument('ui-write-update-start', VALID).ok).toBe(true);
    expect(validateControlDocument('ui-write-update-start', { ...VALID, expectedTargetRecordId: 'a'.repeat(MAX_SAFE_RECORD_ID_LENGTH) }).ok).toBe(true);
  });

  it.each<readonly [string, unknown]>([
    ['an extra property', { ...VALID, extra: true }],
    ['no target', { scenarioId: 'scenario-1', expectedRevision: 1 }],
    ['a null target', { ...VALID, expectedTargetRecordId: null }],
    ['an empty target', { ...VALID, expectedTargetRecordId: '' }],
    ['a target with a path separator', { ...VALID, expectedTargetRecordId: '4/2' }],
    ['a target with a dot', { ...VALID, expectedTargetRecordId: '../x' }],
    ['a too long target', { ...VALID, expectedTargetRecordId: 'a'.repeat(MAX_SAFE_RECORD_ID_LENGTH + 1) }],
    ['no scenario id', { expectedRevision: 1, expectedTargetRecordId: 'rec-1' }],
    ['a bad scenario id', { ...VALID, scenarioId: 'Scenario 1' }],
    ['a revision below the minimum', { ...VALID, expectedRevision: 0 }],
    ['a revision that is not an integer', { ...VALID, expectedRevision: 1.5 }],
    ['a grant id', { ...VALID, grantId: 'grant-1' }],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expect(validateControlDocument('ui-write-update-start', value).ok).toBe(false);
  });

  it('keeps the create start input without a target', () => {
    expect(validateControlDocument('ui-write-start', VALID).ok).toBe(false);
  });
});
