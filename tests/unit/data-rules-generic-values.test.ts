/**
 * 汎用の規則（`src/control/data-rules/generic-values.ts`。Task 29 の設計書 3 章の「型と制約で決まる」、4.2。T29b）の表。
 * - number・range: min・max・step（step の倍数、境界を含む。range は HTML の既定の min・max・step を使う）。
 * - date・month・week・time・datetime-local: min・max があるとき。step は各型の単位（日・月・週・秒）。
 * - color: `#rrggbb`。
 * - select・radio・checkbox: 選択肢の値から（空の値と危険な語の値を除く）。
 * - 作れない場合は、理由（`NEEDS_RULE_INPUT` の細分の仮の型）を返す。
 */
import { describe, expect, it } from 'vitest';
import {
  checkGenericRule,
  generateGenericValue,
  type GenericRuleContext,
  type GenericRuleInputReason,
} from '../../src/control/data-rules/generic-values.js';
import { createDataSeed, createDeterministicStream, type DeterministicStream } from '../../src/control/data-rules/deterministic-stream.js';
import type { CandidateField, CandidateFieldConstraints, CandidateFieldType } from '../../src/discovery/candidate-contracts.js';
import { createSha256Fingerprint } from '../../src/core/ids.js';

const CONTEXT: GenericRuleContext = Object.freeze({ baseDate: '2026-10-13' });

const NO_CONSTRAINTS: CandidateFieldConstraints = Object.freeze({
  pattern: null,
  min: null,
  max: null,
  step: null,
  minlength: null,
  maxlength: null,
  autocomplete: null,
});

const fieldOf = (
  type: CandidateFieldType,
  constraints: Partial<CandidateFieldConstraints> = {},
  options: readonly string[] | null = null,
): CandidateField => ({
  name: 'field',
  tag: type === 'textarea' ? 'textarea' : type.startsWith('select-') ? 'select' : 'input',
  type,
  required: true,
  readonly: false,
  disabled: false,
  hidden: false,
  constraints: { ...NO_CONSTRAINTS, ...constraints },
  options,
  omittedOptionCount: 0,
  hasValue: false,
});

/** 値の集まりを数える seed の数（名前つきの回数。範囲の両端まで出ることの確かめ）。 */
const SAMPLE_SEED_COUNT = 400;

const streamFor = (index: number): DeterministicStream => createDeterministicStream(createDataSeed({
  profileId: 'PROFILE-1',
  scenarioId: 'SCENARIO-1',
  scenarioRevision: 1,
  ruleSetDigest: createSha256Fingerprint('rule-set'),
  executionGrantId: `GRANT-${index}`,
}), 'field:generic');

/** 多くの seed で作った値の集まり（作れない場合は失敗にする）。 */
const sampleValues = (field: CandidateField): ReadonlySet<string> => {
  const values = new Set<string>();
  for (let index = 0; index < SAMPLE_SEED_COUNT; index += 1) {
    const result = generateGenericValue(field, streamFor(index), CONTEXT);
    if (!result.ok) {
      throw new Error(`unexpected reason ${result.reason}`);
    }
    values.add(result.value);
  }
  return values;
};

const reasonOf = (field: CandidateField): GenericRuleInputReason | null => {
  const checked = checkGenericRule(field, CONTEXT);
  const generated = generateGenericValue(field, streamFor(0), CONTEXT);
  // 判定と生成は、同じ理由を返す（判定だけで、生成できるかが分かる）。
  expect(generated.ok ? null : generated.reason).toBe(checked);
  return checked;
};

describe('generic rules: number and range', () => {
  it('produces every multiple of step from min to max, including both bounds', () => {
    expect([...sampleValues(fieldOf('number', { min: '1', max: '5' }))].sort()).toEqual(['1', '2', '3', '4', '5']);
    expect([...sampleValues(fieldOf('number', { min: '0', max: '10', step: '5' }))].sort()).toEqual(['0', '10', '5']);
  });

  it('uses min as the step base and excludes max when it is not on a step', () => {
    expect([...sampleValues(fieldOf('number', { min: '1', max: '8', step: '3' }))].sort()).toEqual(['1', '4', '7']);
  });

  it('handles decimals and negative values without floating point errors', () => {
    expect([...sampleValues(fieldOf('number', { min: '0.1', max: '0.5', step: '0.1' }))].sort())
      .toEqual(['0.1', '0.2', '0.3', '0.4', '0.5']);
    expect([...sampleValues(fieldOf('number', { min: '-1', max: '1', step: '0.5' }))].sort())
      .toEqual(['-0.5', '-1', '0', '0.5', '1']);
  });

  it('uses the HTML defaults of range (min 0, max 100, step 1) when the attributes are absent', () => {
    const values = sampleValues(fieldOf('range'));
    for (const value of values) {
      expect(Number(value)).toBeGreaterThanOrEqual(0);
      expect(Number(value)).toBeLessThanOrEqual(100);
      expect(Number.isInteger(Number(value))).toBe(true);
    }
    expect(reasonOf(fieldOf('range', { min: '10', max: '20' }))).toBeNull();
  });

  it('returns the reason when a value cannot be made from the constraints', () => {
    const table: readonly (readonly [string, CandidateField, GenericRuleInputReason])[] = [
      ['number without min', fieldOf('number', { max: '5' }), 'RANGE_MISSING'],
      ['number without max', fieldOf('number', { min: '5' }), 'RANGE_MISSING'],
      ['number without both', fieldOf('number'), 'RANGE_MISSING'],
      ['min greater than max', fieldOf('number', { min: '5', max: '1' }), 'RANGE_EMPTY'],
      ['zero step', fieldOf('number', { min: '1', max: '2', step: '0' }), 'CONSTRAINT_UNSUPPORTED'],
      ['step any', fieldOf('number', { min: '1', max: '2', step: 'any' }), 'CONSTRAINT_UNSUPPORTED'],
      ['negative step', fieldOf('number', { min: '1', max: '2', step: '-1' }), 'CONSTRAINT_UNSUPPORTED'],
      ['exponent notation', fieldOf('number', { min: '1e2', max: '200' }), 'CONSTRAINT_UNSUPPORTED'],
      ['not a number', fieldOf('number', { min: 'abc', max: '2' }), 'CONSTRAINT_UNSUPPORTED'],
      ['range with min greater than max', fieldOf('range', { min: '50', max: '10' }), 'RANGE_EMPTY'],
      ['too many steps', fieldOf('number', { min: '0', max: '1'.repeat(30) }), 'CONSTRAINT_UNSUPPORTED'],
    ];
    for (const [label, field, reason] of table) {
      expect(reasonOf(field), label).toBe(reason);
    }
  });

  it('produces a value when the range has a single step', () => {
    expect([...sampleValues(fieldOf('number', { min: '3', max: '3' }))]).toEqual(['3']);
    expect([...sampleValues(fieldOf('number', { min: '1', max: '1.5', step: '1' }))]).toEqual(['1']);
  });
});

describe('generic rules: date and time types', () => {
  it('date: produces every day from min to max, including both bounds, across month ends', () => {
    expect([...sampleValues(fieldOf('date', { min: '2026-02-27', max: '2026-03-02' }))].sort())
      .toEqual(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
    expect([...sampleValues(fieldOf('date', { min: '2028-02-28', max: '2028-03-01' }))].sort())
      .toEqual(['2028-02-28', '2028-02-29', '2028-03-01']);
  });

  it('date: uses step in days from min', () => {
    expect([...sampleValues(fieldOf('date', { min: '2026-10-01', max: '2026-10-10', step: '3' }))].sort())
      .toEqual(['2026-10-01', '2026-10-04', '2026-10-07', '2026-10-10']);
  });

  it('month: produces every month from min to max across the year end', () => {
    expect([...sampleValues(fieldOf('month', { min: '2026-11', max: '2027-02' }))].sort())
      .toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
  });

  it('week: produces every ISO week from min to max, including a 53-week year', () => {
    expect([...sampleValues(fieldOf('week', { min: '2026-W52', max: '2027-W02' }))].sort())
      .toEqual(['2026-W52', '2026-W53', '2027-W01', '2027-W02']);
    expect([...sampleValues(fieldOf('week', { min: '2025-W52', max: '2026-W01' }))].sort())
      .toEqual(['2025-W52', '2026-W01']);
  });

  it('time: uses 60 seconds as the default step, and writes seconds only when they are not zero', () => {
    expect([...sampleValues(fieldOf('time', { min: '09:00', max: '09:03' }))].sort())
      .toEqual(['09:00', '09:01', '09:02', '09:03']);
    expect([...sampleValues(fieldOf('time', { min: '09:00', max: '10:00', step: '1800' }))].sort())
      .toEqual(['09:00', '09:30', '10:00']);
    expect([...sampleValues(fieldOf('time', { min: '09:00:00', max: '09:00:02', step: '1' }))].sort())
      .toEqual(['09:00', '09:00:01', '09:00:02']);
  });

  it('datetime-local: crosses the day end with the step in seconds', () => {
    expect([...sampleValues(fieldOf('datetime-local', { min: '2026-10-13T23:00', max: '2026-10-14T01:00', step: '3600' }))].sort())
      .toEqual(['2026-10-13T23:00', '2026-10-14T00:00', '2026-10-14T01:00']);
  });

  it('returns the reason when a date or time value cannot be made', () => {
    const table: readonly (readonly [string, CandidateField, GenericRuleInputReason])[] = [
      ['date without max', fieldOf('date', { min: '2026-10-01' }), 'RANGE_MISSING'],
      ['date without min', fieldOf('date', { max: '2026-10-01' }), 'RANGE_MISSING'],
      ['date reversed', fieldOf('date', { min: '2026-10-02', max: '2026-10-01' }), 'RANGE_EMPTY'],
      ['date not a real day', fieldOf('date', { min: '2026-02-30', max: '2026-03-02' }), 'CONSTRAINT_UNSUPPORTED'],
      ['date wrong shape', fieldOf('date', { min: '2026/10/01', max: '2026-10-02' }), 'CONSTRAINT_UNSUPPORTED'],
      ['date fractional step', fieldOf('date', { min: '2026-10-01', max: '2026-10-02', step: '1.5' }), 'CONSTRAINT_UNSUPPORTED'],
      ['month wrong month', fieldOf('month', { min: '2026-13', max: '2027-01' }), 'CONSTRAINT_UNSUPPORTED'],
      ['week 53 in a 52-week year', fieldOf('week', { min: '2025-W53', max: '2026-W02' }), 'CONSTRAINT_UNSUPPORTED'],
      ['time reversed (over midnight)', fieldOf('time', { min: '23:00', max: '01:00' }), 'RANGE_EMPTY'],
      ['time with fractions of a second', fieldOf('time', { min: '09:00:00.5', max: '10:00' }), 'CONSTRAINT_UNSUPPORTED'],
      ['time hour 24', fieldOf('time', { min: '24:00', max: '24:30' }), 'CONSTRAINT_UNSUPPORTED'],
      ['time step any', fieldOf('time', { min: '09:00', max: '10:00', step: 'any' }), 'CONSTRAINT_UNSUPPORTED'],
      ['datetime-local with a space', fieldOf('datetime-local', { min: '2026-10-13 09:00', max: '2026-10-14T09:00' }), 'CONSTRAINT_UNSUPPORTED'],
      ['datetime-local without max', fieldOf('datetime-local', { min: '2026-10-13T09:00' }), 'RANGE_MISSING'],
    ];
    for (const [label, field, reason] of table) {
      expect(reasonOf(field), label).toBe(reason);
    }
  });
});

describe('generic rules: color', () => {
  it('produces #rrggbb in lowercase hex digits', () => {
    const values = sampleValues(fieldOf('color'));
    expect(values.size).toBeGreaterThan(1);
    for (const value of values) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/u);
    }
  });
});

describe('generic rules: options of select, radio and checkbox', () => {
  it('produces only the option values, excluding empty values and values with a destructive word', () => {
    const options = ['', '  ', 'standard', 'delete', 'premium', '削除する', 'cancel_all', 'standard'];
    for (const type of ['select-one', 'select-multiple', 'radio', 'checkbox'] as const) {
      expect([...sampleValues(fieldOf(type, {}, options))].sort(), type).toEqual(['premium', 'standard']);
    }
  });

  it('checks percent-encoded destructive words too', () => {
    expect([...sampleValues(fieldOf('select-one', {}, ['keep', '%64elete']))]).toEqual(['keep']);
  });

  it('uses the default value `on` of a checkbox', () => {
    expect([...sampleValues(fieldOf('checkbox', {}, ['on']))]).toEqual(['on']);
  });

  it('returns NO_USABLE_OPTION when no option is left, or when there are no options', () => {
    expect(reasonOf(fieldOf('select-one', {}, ['', 'remove', 'キャンセル']))).toBe('NO_USABLE_OPTION');
    expect(reasonOf(fieldOf('select-one', {}, []))).toBe('NO_USABLE_OPTION');
    expect(reasonOf(fieldOf('radio', {}, null))).toBe('NO_USABLE_OPTION');
  });
});

describe('generic rules: types that need a template or a human rule', () => {
  it('returns NOT_GENERIC_TYPE for text-like, secret, file, hidden, url, email and tel fields', () => {
    for (const type of ['text', 'search', 'textarea', 'email', 'url', 'tel', 'password', 'file', 'hidden'] as const) {
      expect(reasonOf(fieldOf(type, { min: '1', max: '2' })), type).toBe('NOT_GENERIC_TYPE');
    }
  });
});

describe('generic rules: determinism and context', () => {
  it('returns the same value for the same stream, and does not depend on the base date for the range', () => {
    const field = fieldOf('number', { min: '1', max: '1000' });
    const left = generateGenericValue(field, streamFor(3), CONTEXT);
    const right = generateGenericValue(field, streamFor(3), { baseDate: '2030-01-01' });
    expect(left).toEqual(right);
  });

  it('rejects a base date that is not a real YYYY-MM-DD date', () => {
    for (const baseDate of ['2026-02-30', '2026/10/13', '', '2026-10-13T00:00']) {
      expect(() => checkGenericRule(fieldOf('color'), { baseDate }), baseDate).toThrow(RangeError);
    }
  });

  it('returns frozen results', () => {
    const result = generateGenericValue(fieldOf('color'), streamFor(0), CONTEXT);
    expect(Object.isFrozen(result)).toBe(true);
  });
});
