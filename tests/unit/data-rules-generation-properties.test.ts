// T29f（Task 29 の設計書 3 章の決定的な生成・メール・電話・一意性、6 章、8 章の G29）: 生成の性質を、純粋な部品の結合（`generateScenarioData` と
// 本物の欄の判定・テンプレート・辞書・値の取り出し）で、多くの seed（名前つきの数）について確かめる。T29c のテスト
// （`data-rules-scenario-data.test.ts`）と重なる所は足さず、足りない所だけを確かめる:
// - メールと電話の形を、owner の判定（`isSyntheticEmailAddress`・`syntheticPhoneFormatOf`）ではなく、設計書の形を書いた独立の正規表現で確かめる
//   （owner の判定が緩んでも気づけるように）。ハイフンなしの形も多くの seed で確かめる。
// - メールと電話の欄の値も、危険な語・秘密に見える語に当たらない（T29c は、この 2 つの欄を除いて確かめている）。
// - 同じ入力で同じ値を、多くの seed のそれぞれで確かめる（T29c は 1 つの seed）。
// - 続けて作るとき（Task 30 が送った記録を履歴として渡す）、電話番号と一意にする欄の組が、履歴と重ならない（多くの回数。ハイフンつきの履歴と
//   ハイフンなしの形の比べを含む）。
import { describe, expect, it } from 'vitest';
import { generateScenarioData, type ScenarioDataInput } from '../../src/control/data-rules/scenario-data.js';
import { isSecretLikeQueryName } from '../../src/core/secret-query-names.js';
import type { CandidateField } from '../../src/discovery/candidate-contracts.js';
import { readParametersHaveDestructiveWord } from '../../src/discovery/classify.js';
import { BASE_DATE, candidateWith, ruleSetFor, scenarioFor, seedInputFor } from './data-rule-scenario-samples.js';
import { NO_CONSTRAINTS, sampleField } from './discovery-candidate-samples.js';

/** 多くの seed で確かめる数（実行の許可の id を変える）。 */
const PROPERTY_SEED_COUNT = 200;
/** 続けて作る回数（履歴を積み重ねる）。 */
const SEQUENTIAL_CREATE_COUNT = 120;

/** 設計書の形（owner の正規表現とは別に、ここで書く）。 */
const EMAIL_SHAPE = /^[a-z0-9._-]+@example\.invalid$/u;
const HYPHENATED_PHONE_SHAPE = /^090-0[0-9]{3}-[0-9]{4}$/u;
const COMPACT_PHONE_SHAPE = /^0900[0-9]{7}$/u;
/** ハイフンなしの形しか入らない電話の欄の長さ（`0900` と 7 桁）。 */
const COMPACT_PHONE_LENGTH = '11';

const withConstraints = (field: CandidateField, constraints: Partial<CandidateField['constraints']>): CandidateField =>
  ({ ...field, constraints: { ...NO_CONSTRAINTS, ...constraints } });

/** 顧客（氏名とフリガナ、メール、ハイフンつきの電話）。一意にする欄の組はテンプレートの既定（氏名とフリガナ）。 */
const CUSTOMER_FIELDS: readonly CandidateField[] = [
  sampleField('name', 'text', { required: true }),
  sampleField('name_kana'),
  sampleField('email', 'email'),
  sampleField('tel', 'tel'),
];
/** ハイフンを許さない電話の欄（maxlength が 11）。 */
const COMPACT_PHONE_FIELDS: readonly CandidateField[] = [withConstraints(sampleField('tel', 'tel'), { maxlength: COMPACT_PHONE_LENGTH })];

const inputFor = (
  fields: readonly CandidateField[],
  grant: string,
  history: { readonly usedUniqueKeys?: readonly string[]; readonly usedPhoneNumbers?: readonly string[] } = {},
): ScenarioDataInput => {
  const candidate = candidateWith(fields);
  const scenario = scenarioFor(candidate, fields.map((field) => field.name));
  const ruleSet = ruleSetFor(scenario);
  return {
    ruleSet,
    scenario,
    candidate,
    seedInput: seedInputFor(scenario, ruleSet, grant),
    usedUniqueKeys: history.usedUniqueKeys ?? [],
    usedPhoneNumbers: history.usedPhoneNumbers ?? [],
    baseDate: BASE_DATE,
  };
};

const generated = (input: ScenarioDataInput) => {
  const result = generateScenarioData(input);
  if (!result.ok) {
    throw new Error(`not generated: ${JSON.stringify(result.problems)}`);
  }
  return result;
};

const stringOf = (values: Readonly<Record<string, string | null>>, name: string): string => {
  const value = values[name];
  if (typeof value !== 'string') {
    throw new Error(`no value for ${name}`);
  }
  return value;
};

/** 電話番号の数字だけ（ハイフンを除く。owner の部品を使わない）。 */
const digitsOf = (phone: string): string => phone.split('-').join('');
/** ハイフンなしの番号を、ハイフンつきの形に書き直す（`090-0XXX-XXXX`）。 */
const HYPHEN_POSITIONS = Object.freeze({ first: 3, second: 7 });
const hyphenatedOf = (compact: string): string =>
  `${compact.slice(0, HYPHEN_POSITIONS.first)}-${compact.slice(HYPHEN_POSITIONS.first, HYPHEN_POSITIONS.second)}-${compact.slice(HYPHEN_POSITIONS.second)}`;

const seeds = (count: number): readonly string[] => Array.from({ length: count }, (_unused, index) => `grant-property-${String(index)}`);

describe('generation properties over many seeds (T29f)', () => {
  it('makes only example.invalid addresses and only the 090-0XXX-XXXX phone shape, with the same values for the same input', () => {
    for (const grant of seeds(PROPERTY_SEED_COUNT)) {
      const first = generated(inputFor(CUSTOMER_FIELDS, grant));
      expect(generated(inputFor(CUSTOMER_FIELDS, grant)), grant).toEqual(first);
      expect(stringOf(first.values, 'email'), grant).toMatch(EMAIL_SHAPE);
      expect(stringOf(first.values, 'email').split('@'), grant).toHaveLength(2);
      expect(stringOf(first.values, 'tel'), grant).toMatch(HYPHENATED_PHONE_SHAPE);
    }
  });

  it('makes only the 0900XXXXXXX phone shape when the field does not allow hyphens, with the same values for the same input', () => {
    for (const grant of seeds(PROPERTY_SEED_COUNT)) {
      const first = generated(inputFor(COMPACT_PHONE_FIELDS, grant));
      expect(generated(inputFor(COMPACT_PHONE_FIELDS, grant)), grant).toEqual(first);
      expect(stringOf(first.values, 'tel'), grant).toMatch(COMPACT_PHONE_SHAPE);
    }
  });

  it('makes no dangerous or secret-looking word in the email and phone values either', () => {
    for (const grant of seeds(PROPERTY_SEED_COUNT)) {
      for (const fields of [CUSTOMER_FIELDS, COMPACT_PHONE_FIELDS]) {
        for (const [name, value] of Object.entries(generated(inputFor(fields, grant)).values)) {
          if (value === null) {
            continue;
          }
          expect(readParametersHaveDestructiveWord({ '': value }), `${grant} ${name}`).toBe(false);
          expect(isSecretLikeQueryName(value), `${grant} ${name}`).toBe(false);
        }
      }
    }
  });
});

describe('generation properties over a sequence of creates (T29f)', () => {
  it('never reuses a phone number or a unique key of the history', () => {
    const usedPhoneNumbers: string[] = [];
    const usedUniqueKeys: string[] = [];
    for (const grant of seeds(SEQUENTIAL_CREATE_COUNT)) {
      const result = generated(inputFor(CUSTOMER_FIELDS, grant, { usedUniqueKeys, usedPhoneNumbers }));
      const phone = stringOf(result.values, 'tel');
      expect(phone, grant).toMatch(HYPHENATED_PHONE_SHAPE);
      expect(usedPhoneNumbers.map(digitsOf), grant).not.toContain(digitsOf(phone));
      expect(result.uniqueKey, grant).not.toBeNull();
      expect(usedUniqueKeys, grant).not.toContain(result.uniqueKey);
      usedPhoneNumbers.push(phone);
      usedUniqueKeys.push(result.uniqueKey ?? '');
    }
    expect(new Set(usedPhoneNumbers.map(digitsOf)).size).toBe(SEQUENTIAL_CREATE_COUNT);
    expect(new Set(usedUniqueKeys).size).toBe(SEQUENTIAL_CREATE_COUNT);
  });

  it('never reuses a number of the history in the other shape (the history in 090-0XXX-XXXX, the field in 0900XXXXXXX)', () => {
    const history: string[] = [];
    for (const grant of seeds(SEQUENTIAL_CREATE_COUNT)) {
      const phone = stringOf(generated(inputFor(COMPACT_PHONE_FIELDS, grant, { usedPhoneNumbers: history })).values, 'tel');
      expect(phone, grant).toMatch(COMPACT_PHONE_SHAPE);
      expect(history.map(digitsOf), grant).not.toContain(phone);
      history.push(hyphenatedOf(phone));
    }
    expect(history.every((phone) => HYPHENATED_PHONE_SHAPE.test(phone))).toBe(true);
    expect(new Set(history).size).toBe(SEQUENTIAL_CREATE_COUNT);
  });
});
