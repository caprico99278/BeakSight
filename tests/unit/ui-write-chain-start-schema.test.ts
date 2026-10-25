// T41g-3（Task 41 の設計書 3.5.1 の末尾。T41R5 の M-1）: 画面の「登録してから更新する」の Server Function（`startWriteCreateThenUpdateFn`）の入力のスキーマ
// （`schemas/control/ui-write-chain-start.schema.json`）。
// - 更新のシナリオの id と、画面が読んだ更新のシナリオの版と、画面が読んだ台帳の登録のシナリオの版（登録の許可の発行に渡す。違えば何も始めない）だけ。
//   余分な項目、id の形の違い、版の最小の違いは拒む。値・資格情報・トークンの項目を持たない。
// - 開始の入力（`ui-write-start`）は変えない（登録のシナリオの版を持てない）。
import { describe, expect, it } from 'vitest';
import { CONTROL_SCHEMA_NAMES, validateControlDocument } from '../../src/control/control-schema-validator.js';

const VALID = Object.freeze({ scenarioId: 'scenario-1', expectedRevision: 2, expectedCreateRevision: 3 });

describe('ui-write-chain-start schema (T41g-3)', () => {
  it('is registered as a control schema', () => {
    expect(CONTROL_SCHEMA_NAMES).toContain('ui-write-chain-start');
  });

  it('accepts the update scenario id, its revision and the revision of the ledger create scenario the screen read', () => {
    expect(validateControlDocument('ui-write-chain-start', VALID).ok).toBe(true);
  });

  it.each<readonly [string, unknown]>([
    ['an extra property', { ...VALID, extra: true }],
    ['no create revision', { scenarioId: 'scenario-1', expectedRevision: 2 }],
    ['a create revision below the minimum', { ...VALID, expectedCreateRevision: 0 }],
    ['a create revision that is not an integer', { ...VALID, expectedCreateRevision: 1.5 }],
    ['no scenario id', { expectedRevision: 2, expectedCreateRevision: 3 }],
    ['a bad scenario id', { ...VALID, scenarioId: 'Scenario 1' }],
    ['a revision below the minimum', { ...VALID, expectedRevision: 0 }],
    ['a grant id', { ...VALID, grantId: 'grant-1' }],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expect(validateControlDocument('ui-write-chain-start', value).ok).toBe(false);
  });

  it('keeps the start input without the create revision', () => {
    expect(validateControlDocument('ui-write-start', VALID).ok).toBe(false);
  });
});
