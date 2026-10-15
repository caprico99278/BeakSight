// T31a（Task 31 の設計書 3 章の「削除にあたる変更の遮断」、5 章）: 無効化の語（`src/discovery/classification-words.ts` の
// `DISCOVERY_DISABLING_WORDS`）に当たる選択肢の値を、入力の規則の生成で選ばない（`src/control/data-rules/generic-values.ts` の
// `usableOptionValues`・`valueHasDisablingWord`）。
// - 値の比べ方: 英語の語は語の単位（`stopwatch` は `stop` に当たらない）、日本語の語は部分一致（欄の名前の語の比べの owner の
//   `fieldNameHasListedWord`）。`0`・`false`・`off` は一覧に入れない（数量などの普通の選択肢を壊さない）。
// - 生成（CREATE の select・radio）: 多くの seed で、無効化の語の選択肢を選ばない。選べる選択肢が残らなければ `NO_USABLE_OPTION`。
// - 人の固定の値: 危険な語と同じく拒む（`FIXED_VALUE_VIOLATES_CONSTRAINT`）。
// 例の値は匿名の値だけ。
import { describe, expect, it } from 'vitest';
import { evaluateRuleSet } from '../../src/control/data-rules/field-evaluation.js';
import {
  checkGenericRule,
  generateGenericValue,
  usableOptionValues,
  valueHasDisablingWord,
} from '../../src/control/data-rules/generic-values.js';
import { createDataSeed, createDeterministicStream } from '../../src/control/data-rules/deterministic-stream.js';
import { generateScenarioData } from '../../src/control/data-rules/scenario-data.js';
import type { RuleProblem } from '../../src/control/data-rules/rule-contracts.js';
import { createSha256Fingerprint } from '../../src/core/ids.js';
import type { CandidateField } from '../../src/discovery/candidate-contracts.js';
import { DISCOVERY_DISABLING_WORDS } from '../../src/discovery/classification-words.js';
import { BASE_DATE, candidateWith, ruleSetFor, scenarioFor, seedInputFor } from './data-rule-scenario-samples.js';
import { sampleFieldRule } from './data-rule-samples.js';
import { sampleField } from './discovery-candidate-samples.js';

/** 多くの seed で確かめる数（名前つきの回数）。 */
const DISABLING_SEED_COUNT = 300;

/** 無効化の語に当たる値（大文字小文字・全角・半角のカタカナ・区切りの違いを含む）。 */
const DISABLING_VALUES: readonly string[] = [
  'inactive', 'INACTIVE', 'Inactive user', 'hidden', 'is_hidden', 'hide', 'closed', 'CLOSED', 'cancel', 'cancelled', 'canceled', 'suspend',
  'suspended', 'stop', 'stopped', 'unpublished', 'ｈｉｄｄｅｎ', '非表示', '無効', '停止', '利用停止', '取消', '取り消し', '中止', '休止', '解約',
  '退会', '非公開', 'キャンセル', 'ｷｬﾝｾﾙ',
];

/** 無効化の語に当たらない値（`0`・`false`・`off` と、語の一部だけを含む値を含む）。 */
const USABLE_VALUES: readonly string[] = [
  '0', '1', 'false', 'true', 'off', 'on', 'active', 'open', 'standard', 'premium', 'stopwatch', 'nonstop', 'enclosed', 'closet', 'unhidden',
  '表示', '公開', '有効', '通常', '会員', 'a',
];

describe('T31a: the disabling words of option values', () => {
  it('keeps the closed list frozen, folded and without duplicates, without 0, false and off', () => {
    expect(Object.isFrozen(DISCOVERY_DISABLING_WORDS)).toBe(true);
    expect(new Set(DISCOVERY_DISABLING_WORDS).size).toBe(DISCOVERY_DISABLING_WORDS.length);
    for (const word of DISCOVERY_DISABLING_WORDS) {
      expect(word.length, word).toBeGreaterThan(0);
      expect(word.normalize('NFKC').toUpperCase().toLowerCase(), word).toBe(word);
    }
    expect(DISCOVERY_DISABLING_WORDS).toEqual(expect.arrayContaining([
      'inactive', 'hidden', 'closed', 'cancel', 'cancelled', 'suspend', 'suspended', 'stop', '非表示', '無効', '停止', '取消', '中止', '休止', '解約',
      '退会', '非公開',
    ]));
    for (const word of ['0', 'false', 'off', 'no', 'none']) {
      expect(DISCOVERY_DISABLING_WORDS, word).not.toContain(word);
    }
  });

  it('reads the disabling words in values, word by word for English words', () => {
    for (const value of DISABLING_VALUES) {
      expect(valueHasDisablingWord(value), value).toBe(true);
    }
    for (const value of USABLE_VALUES) {
      expect(valueHasDisablingWord(value), value).toBe(false);
    }
  });

  it('removes the options with a disabling word from the usable options (in order, without duplicates)', () => {
    expect(usableOptionValues(['standard', 'inactive', 'premium', '非表示', 'closed', 'standard', '0', 'off'])).toEqual(['standard', 'premium', '0', 'off']);
    expect(usableOptionValues([...DISABLING_VALUES])).toEqual([]);
    expect(usableOptionValues([...USABLE_VALUES])).toEqual([...USABLE_VALUES]);
  });
});

describe('T31a: the generic rule never chooses an option with a disabling word', () => {
  const fieldOf = (type: 'select-one' | 'select-multiple' | 'radio', options: readonly string[]): CandidateField =>
    sampleField('course', type, { options: [...options], required: true });
  const streamFor = (index: number) => createDeterministicStream(createDataSeed({
    profileId: 'PROFILE-1',
    scenarioId: 'SCENARIO-1',
    scenarioRevision: 1,
    ruleSetDigest: createSha256Fingerprint('rule-set'),
    executionGrantId: `GRANT-${String(index)}`,
  }), 'field:generic');
  const context = { baseDate: BASE_DATE };

  it('chooses only the usable options over many seeds', () => {
    const options = ['standard', 'inactive', 'hidden', 'premium', '非表示', '停止', 'closed', 'stop'];
    for (const type of ['select-one', 'select-multiple', 'radio'] as const) {
      const values = new Set<string>();
      for (let index = 0; index < DISABLING_SEED_COUNT; index += 1) {
        const result = generateGenericValue(fieldOf(type, options), streamFor(index), context);
        if (!result.ok) {
          throw new Error(`unexpected reason ${result.reason}`);
        }
        values.add(result.value);
      }
      expect([...values].sort(), type).toEqual(['premium', 'standard']);
    }
  });

  it('returns NO_USABLE_OPTION when only options with a disabling word are left', () => {
    for (const type of ['select-one', 'radio'] as const) {
      const field = fieldOf(type, ['', 'inactive', '非公開', 'cancelled']);
      expect(checkGenericRule(field, context), type).toBe('NO_USABLE_OPTION');
      const generated = generateGenericValue(field, streamFor(0), context);
      expect(generated.ok ? null : generated.reason, type).toBe('NO_USABLE_OPTION');
    }
  });
});

describe('T31a: the scenario data of CREATE never chooses an option with a disabling word', () => {
  const FIELDS: readonly CandidateField[] = [
    sampleField('course', 'select-one', { options: ['a', 'closed', 'b', '停止', 'hidden'], required: true }),
    sampleField('plan', 'radio', { options: ['inactive', 'x', '休止', 'y'], required: true }),
  ];
  const inputFor = (fields: readonly CandidateField[], grant: string) => {
    const candidate = candidateWith(fields);
    const scenario = scenarioFor(candidate, fields.map((field) => field.name));
    const ruleSet = ruleSetFor(scenario);
    return {
      ruleSet,
      scenario,
      candidate,
      seedInput: seedInputFor(scenario, ruleSet, grant),
      usedUniqueKeys: [],
      usedPhoneNumbers: [],
      baseDate: BASE_DATE,
    };
  };

  it('chooses only the usable options over many seeds', () => {
    const chosen = { course: new Set<string>(), plan: new Set<string>() };
    for (let index = 0; index < DISABLING_SEED_COUNT; index += 1) {
      const result = generateScenarioData(inputFor(FIELDS, `grant-disabling-${String(index)}`));
      if (!result.ok) {
        throw new Error(`not generated: ${JSON.stringify(result.problems)}`);
      }
      for (const name of ['course', 'plan'] as const) {
        const value = result.values[name];
        expect(typeof value, name).toBe('string');
        chosen[name].add(String(value));
      }
    }
    expect([...chosen.course].sort()).toEqual(['a', 'b']);
    expect([...chosen.plan].sort()).toEqual(['x', 'y']);
  });

  it('cannot generate when a required choice has only options with a disabling word (NO_USABLE_OPTION)', () => {
    const fields = [sampleField('course', 'select-one', { options: ['closed', '停止'], required: true })];
    const result = generateScenarioData(inputFor(fields, 'grant-disabling-none'));
    expect(result.ok).toBe(false);
    const candidate = candidateWith(fields);
    const scenario = scenarioFor(candidate, ['course']);
    const evaluation = evaluateRuleSet(ruleSetFor(scenario), scenario, candidate);
    expect(evaluation.fields.find((field) => field.fieldName === 'course')?.problem)
      .toEqual({ code: 'NEEDS_RULE_INPUT', detail: 'NO_USABLE_OPTION' } satisfies RuleProblem);
  });
});

describe('T31a: a human fixed value with a disabling word is rejected like a dangerous word', () => {
  const problemOf = (field: CandidateField, fixedValues: readonly string[]): RuleProblem | null => {
    const candidate = candidateWith([field]);
    const scenario = scenarioFor(candidate, [field.name]);
    const ruleSet = ruleSetFor(scenario, [sampleFieldRule(field.name, {
      semanticKind: field.type === 'select-one' ? 'FIXED_LIST' : 'OUT_OF_TEMPLATE',
      method: 'FROM_FIXED_LIST',
      fixedValues: [...fixedValues],
    })]);
    return evaluateRuleSet(ruleSet, scenario, candidate).fields.find((evaluated) => evaluated.fieldName === field.name)?.problem ?? null;
  };
  const VIOLATES: RuleProblem = { code: 'RULE_CONFLICT', detail: 'FIXED_VALUE_VIOLATES_CONSTRAINT' };

  it('rejects a fixed option value with a disabling word, even when the option exists', () => {
    const field = sampleField('course', 'select-one', { options: ['a', 'closed', '非表示'] });
    expect(problemOf(field, ['closed'])).toEqual(VIOLATES);
    expect(problemOf(field, ['非表示'])).toEqual(VIOLATES);
    expect(problemOf(field, ['a'])).toBeNull();
  });

  it('rejects a fixed text value with a disabling word (the same as a dangerous word)', () => {
    const field = sampleField('code_x');
    expect(problemOf(field, ['A1', 'inactive'])).toEqual(VIOLATES);
    expect(problemOf(field, ['利用停止'])).toEqual(VIOLATES);
    expect(problemOf(field, ['A1', 'stopwatch'])).toBeNull();
  });
});
