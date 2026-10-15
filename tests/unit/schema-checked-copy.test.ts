// CCX-17（台帳の CC-077）: 管理の契約のスキーマで確かめた、凍結した写し（`src/control/schema-checked-copy.ts`）。
// - JSON の写し（入力を変えない）→ スキーマで確かめる → 凍結。通らなければ誤りの文（`schemaCheckedCopyOf`）か `RangeError`（`requireSchemaCheckedCopy`）。
// - 関数などの JSON でない値は写しで落ち、`undefined` はスキーマで拒まれる。
import { describe, expect, it } from 'vitest';
import { requireSchemaCheckedCopy, schemaCheckedCopyOf } from '../../src/control/schema-checked-copy.js';
import { sampleScenario } from './approval-samples.js';

describe('schema checked copies (CCX-17)', () => {
  it('returns a frozen copy that passed the control schema, and does not change the input', () => {
    const input = sampleScenario();
    const checked = schemaCheckedCopyOf<typeof input>('scenario', input);
    expect(checked.ok && checked.value).toEqual(input);
    expect(checked.ok && checked.value !== input && Object.isFrozen(checked.value) && Object.isFrozen(checked.value.fieldNames)).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
  });

  it('returns the schema errors without a copy, and throws a RangeError with the subject for the required form', () => {
    const broken = { ...sampleScenario(), extra: true };
    const checked = schemaCheckedCopyOf('scenario', broken);
    expect(checked.ok).toBe(false);
    expect(checked.ok ? [] : checked.errors.length).toBeGreaterThan(0);
    expect(() => requireSchemaCheckedCopy('scenario', 'scenario revision', broken)).toThrow(/^the scenario revision does not match the contract: /u);
    expect(requireSchemaCheckedCopy('scenario', 'scenario revision', sampleScenario())).toEqual(sampleScenario());
  });

  it('drops values that are not JSON and rejects undefined through the schema', () => {
    expect(schemaCheckedCopyOf('scenario', undefined).ok).toBe(false);
    const withFunction = { ...sampleScenario(), toString: () => 'x' };
    const checked = schemaCheckedCopyOf<object>('scenario', withFunction);
    expect(checked.ok && Object.hasOwn(checked.value, 'toString')).toBe(false);
  });
});
