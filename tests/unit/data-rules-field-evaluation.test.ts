// T29c（Task 29 の設計書 3 章の欄ごとの判定、4.2、6 章）: 欄の判定（`src/control/data-rules/field-evaluation.ts` の `evaluateRuleSet`）の表。
// - 優先順位（汎用 → テンプレート → 人の上書き）、送る欄すべてに規則、required の未選択、状態の欄、外部到達の欄（メール・電話・住所・通知）、
//   password・file・url、既定の値、範囲・固定の値・pattern、欄どうしの関係。
// 例の値は匿名の値だけ。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EXTERNAL_NOTIFICATION_AT_APPROVAL,
  PRE_APPROVAL_EVALUATION_PREMISE,
  evaluateRuleSet,
  type FieldEvaluation,
} from '../../src/control/data-rules/field-evaluation.js';
import type { RuleProblem } from '../../src/control/data-rules/rule-contracts.js';
import type { CandidateField } from '../../src/discovery/candidate-contracts.js';
import { ALL_CONFIRMED } from './approval-samples.js';
import { NOTIFICATION_UNCONFIRMED, candidateWith, ruleSetFor, scenarioFor } from './data-rule-scenario-samples.js';
import { sampleFieldRule } from './data-rule-samples.js';
import { NO_CONSTRAINTS, sampleField } from './discovery-candidate-samples.js';

const withConstraints = (field: CandidateField, constraints: Partial<CandidateField['constraints']>): CandidateField =>
  ({ ...field, constraints: { ...NO_CONSTRAINTS, ...constraints } });

interface Case {
  readonly fields: readonly CandidateField[];
  readonly selected: readonly string[];
  readonly rules?: Parameters<typeof ruleSetFor>[1];
  readonly relations?: Parameters<typeof ruleSetFor>[2] extends infer O ? O extends { relations?: infer R } ? R : never : never;
  readonly confirmed?: boolean;
}

const evaluate = (testCase: Case) => {
  const candidate = candidateWith(testCase.fields);
  const scenario = scenarioFor(candidate, testCase.selected, testCase.confirmed === false ? { sideEffectConfirmations: NOTIFICATION_UNCONFIRMED } : {});
  return evaluateRuleSet(ruleSetFor(scenario, testCase.rules ?? [], testCase.relations === undefined ? {} : { relations: testCase.relations }),
    scenario, candidate);
};

const fieldOf = (result: ReturnType<typeof evaluate>, name: string): FieldEvaluation => {
  const found = result.fields.find((field) => field.fieldName === name);
  if (found === undefined) {
    throw new Error(`no evaluation for ${name}`);
  }
  return found;
};

const NEEDS = (detail: string): RuleProblem => ({ code: 'NEEDS_RULE_INPUT', detail } as RuleProblem);
const CONFLICT = (detail: string): RuleProblem => ({ code: 'RULE_CONFLICT', detail } as RuleProblem);

describe('evaluateRuleSet: the table of field judgements (T29c)', () => {
  it.each<readonly [string, Case, string, RuleProblem | null, string | null]>([
    // 優先順位
    ['a name by the template', { fields: [sampleField('name')], selected: ['name'] }, 'name', null, 'TEMPLATE'],
    ['a plain number with a range by the generic rule', {
      fields: [withConstraints(sampleField('level', 'number'), { min: '1', max: '3' })], selected: ['level'],
    }, 'level', null, 'GENERIC'],
    ['a quantity by the template (default range)', { fields: [sampleField('quantity', 'number')], selected: ['quantity'] }, 'quantity', null,
      'TEMPLATE'],
    ['a human rule over the template', {
      fields: [sampleField('name')], selected: ['name'],
      rules: [sampleFieldRule('name', { semanticKind: 'FIXED_LIST', method: 'FROM_FIXED_LIST', fixedValues: ['山田太郎'] })],
    }, 'name', null, 'HUMAN'],
    // 推せない・範囲
    ['an undecided text', { fields: [sampleField('code_x')], selected: ['code_x'] }, 'code_x', NEEDS('SEMANTIC_KIND_UNDECIDED'), null],
    ['an undecided text with a human fixed list', {
      fields: [sampleField('code_x')], selected: ['code_x'],
      rules: [sampleFieldRule('code_x', { semanticKind: 'OUT_OF_TEMPLATE', method: 'FROM_FIXED_LIST', fixedValues: ['A1'] })],
    }, 'code_x', null, 'HUMAN'],
    ['an out-of-template rule without values', {
      fields: [sampleField('code_x')], selected: ['code_x'], rules: [sampleFieldRule('code_x', { semanticKind: 'OUT_OF_TEMPLATE' })],
    }, 'code_x', NEEDS('NO_RULE'), 'HUMAN'],
    ['a number without a range', { fields: [sampleField('level', 'number')], selected: ['level'] }, 'level', NEEDS('RANGE_MISSING'), 'GENERIC'],
    ['a number with min above max', {
      fields: [withConstraints(sampleField('level', 'number'), { min: '5', max: '1' })], selected: ['level'],
    }, 'level', NEEDS('RANGE_EMPTY'), 'GENERIC'],
    ['a number with step any', {
      fields: [withConstraints(sampleField('level', 'number'), { min: '1', max: '5', step: 'any' })], selected: ['level'],
    }, 'level', NEEDS('CONSTRAINT_UNSUPPORTED'), 'GENERIC'],
    ['a date without a range', { fields: [sampleField('when', 'date')], selected: ['when'] }, 'when', NEEDS('RANGE_MISSING'), 'GENERIC'],
    ['a human range inside the field', {
      fields: [withConstraints(sampleField('level', 'number'), { min: '1', max: '10' })], selected: ['level'],
      rules: [sampleFieldRule('level', { range: { min: '2', max: '4', step: null } })],
    }, 'level', null, 'HUMAN'],
    ['a human range outside the field', {
      fields: [withConstraints(sampleField('level', 'number'), { min: '1', max: '10' })], selected: ['level'],
      rules: [sampleFieldRule('level', { range: { min: '0', max: '4', step: null } })],
    }, 'level', CONFLICT('RANGE_OUTSIDE_FIELD_CONSTRAINT'), 'HUMAN'],
    ['a human range that fills a missing date range', {
      fields: [sampleField('when', 'date')], selected: ['when'],
      rules: [sampleFieldRule('when', { semanticKind: 'GENERIC_DATETIME', range: { min: '2026-11-01', max: '2026-11-30', step: null } })],
    }, 'when', null, 'HUMAN'],
    // 種類と型
    ['a human kind that does not fit the type', {
      fields: [withConstraints(sampleField('level', 'number'), { min: '1', max: '3' })], selected: ['level'],
      rules: [sampleFieldRule('level', { semanticKind: 'FULL_NAME', method: 'FROM_TEMPLATE' })],
    }, 'level', CONFLICT('SEMANTIC_KIND_TYPE_MISMATCH'), 'HUMAN'],
    ['fixed values outside the options', {
      fields: [sampleField('course', 'select-one', { options: ['a', 'b'] })], selected: ['course'],
      rules: [sampleFieldRule('course', { semanticKind: 'FIXED_LIST', method: 'FROM_FIXED_LIST', fixedValues: ['c'] })],
    }, 'course', CONFLICT('FIXED_VALUE_VIOLATES_CONSTRAINT'), 'HUMAN'],
    ['a fixed value with a dangerous word', {
      fields: [sampleField('code_x')], selected: ['code_x'],
      rules: [sampleFieldRule('code_x', { semanticKind: 'OUT_OF_TEMPLATE', method: 'FROM_FIXED_LIST', fixedValues: ['delete-all'] })],
    }, 'code_x', CONFLICT('FIXED_VALUE_VIOLATES_CONSTRAINT'), 'HUMAN'],
    ['a fixed value longer than maxlength', {
      fields: [withConstraints(sampleField('code_x'), { maxlength: '2' })], selected: ['code_x'],
      rules: [sampleFieldRule('code_x', { semanticKind: 'OUT_OF_TEMPLATE', method: 'FROM_FIXED_LIST', fixedValues: ['ABC'] })],
    }, 'code_x', CONFLICT('FIXED_VALUE_VIOLATES_CONSTRAINT'), 'HUMAN'],
    // フリガナと pattern
    ['a katakana pattern for the kana', {
      fields: [withConstraints(sampleField('name_kana'), { pattern: '[ァ-ヶー]+' })], selected: ['name_kana'],
    }, 'name_kana', null, 'TEMPLATE'],
    ['a hiragana pattern for the kana', {
      fields: [withConstraints(sampleField('name_kana'), { pattern: '[ぁ-んー]+' })], selected: ['name_kana'],
    }, 'name_kana', NEEDS('PATTERN_UNSUPPORTED'), 'TEMPLATE'],
    ['a name that no entry fits', {
      fields: [withConstraints(sampleField('name'), { maxlength: '1' })], selected: ['name'],
    }, 'name', NEEDS('LENGTH_UNSATISFIABLE'), 'TEMPLATE'],
    ['an invalid pattern', {
      fields: [withConstraints(sampleField('note', 'text'), { pattern: '(' })], selected: ['note'],
    }, 'note', NEEDS('PATTERN_UNSUPPORTED'), 'TEMPLATE'],
    // メール
    ['an email without the notification confirmation', {
      fields: [sampleField('email', 'email')], selected: ['email'], confirmed: false,
    }, 'email', { code: 'EXTERNAL_DELIVERY_BLOCKED', detail: 'EXTERNAL_NOTIFICATION_UNCONFIRMED' }, null],
    ['an email with the confirmation', { fields: [sampleField('email', 'email')], selected: ['email'] }, 'email', null, 'TEMPLATE'],
    ['an email shorter than the synthetic address', {
      fields: [withConstraints(sampleField('email', 'email'), { maxlength: '10' })], selected: ['email'],
    }, 'email', NEEDS('LENGTH_UNSATISFIABLE'), 'TEMPLATE'],
    ['a human fixed email outside example.invalid', {
      fields: [sampleField('email', 'email')], selected: ['email'],
      rules: [sampleFieldRule('email', { semanticKind: 'EMAIL', method: 'FROM_FIXED_LIST', fixedValues: ['a@example.com'] })],
    }, 'email', CONFLICT('FIXED_VALUE_VIOLATES_CONSTRAINT'), 'HUMAN'],
    ['a human non-email kind on an email field', {
      fields: [sampleField('email', 'email')], selected: ['email'], rules: [sampleFieldRule('email', { semanticKind: 'NOTE', method: 'FROM_TEMPLATE' })],
    }, 'email', CONFLICT('SEMANTIC_KIND_TYPE_MISMATCH'), 'HUMAN'],
    // 電話
    ['a phone without the notification confirmation', {
      fields: [sampleField('tel', 'tel')], selected: ['tel'], confirmed: false,
    }, 'tel', { code: 'EXTERNAL_DELIVERY_BLOCKED', detail: 'EXTERNAL_NOTIFICATION_UNCONFIRMED' }, null],
    ['a phone with the confirmation', { fields: [sampleField('tel', 'tel')], selected: ['tel'] }, 'tel', null, 'TEMPLATE'],
    ['a phone that allows only the compact form', {
      fields: [withConstraints(sampleField('tel', 'tel'), { pattern: '[0-9]{11}' })], selected: ['tel'],
    }, 'tel', null, 'TEMPLATE'],
    ['a phone that allows neither form', {
      fields: [withConstraints(sampleField('tel', 'tel'), { maxlength: '10' })], selected: ['tel'],
    }, 'tel', NEEDS('PHONE_FORMAT_UNSUPPORTED'), 'TEMPLATE'],
    ['a phone with a human fixed list', {
      fields: [sampleField('tel', 'tel')], selected: ['tel'],
      rules: [sampleFieldRule('tel', { semanticKind: 'PHONE', method: 'FROM_FIXED_LIST', fixedValues: ['03-0000-0000'] })],
    }, 'tel', null, 'HUMAN'],
    // 住所・url
    ['an address', { fields: [sampleField('address')], selected: ['address'] }, 'address', NEEDS('ADDRESS_FIELD'), null],
    ['an address by autocomplete', {
      fields: [withConstraints(sampleField('x'), { autocomplete: 'postal-code' })], selected: ['x'],
    }, 'x', NEEDS('ADDRESS_FIELD'), null],
    ['an address with a human fixed list', {
      fields: [sampleField('address')], selected: ['address'],
      rules: [sampleFieldRule('address', { semanticKind: 'OUT_OF_TEMPLATE', method: 'FROM_FIXED_LIST', fixedValues: ['テスト用の住所'] })],
    }, 'address', null, 'HUMAN'],
    ['a url', { fields: [sampleField('website', 'url')], selected: ['website'] }, 'website', NEEDS('URL_FIELD'), null],
    // 通知
    ['an optional notification checkbox', { fields: [sampleField('notify', 'checkbox', { options: ['1'] })], selected: ['notify'] }, 'notify',
      null, 'OPT_OUT'],
    ['a required notification checkbox', {
      fields: [sampleField('newsletter', 'checkbox', { options: ['1'], required: true })], selected: ['newsletter'],
    }, 'newsletter', CONFLICT('NOTIFICATION_OPT_OUT_UNAVAILABLE'), null],
    ['a notification select with a no option', {
      fields: [sampleField('mail_magazine', 'select-one', { options: ['yes', 'no'], required: true })], selected: ['mail_magazine'],
    }, 'mail_magazine', null, 'OPT_OUT'],
    ['a notification select without a no option', {
      fields: [sampleField('sms', 'select-one', { options: ['daily', 'weekly'], required: true })], selected: ['sms'],
    }, 'sms', CONFLICT('NOTIFICATION_OPT_OUT_UNAVAILABLE'), null],
    // T29c fix round 1: 否定の名前の通知の欄は、チェックしない側が「送らない」とは限らないので止める（人の固定の値があれば、それを使う）。
    ['a negated notification checkbox', { fields: [sampleField('no_newsletter', 'checkbox', { options: ['1'] })], selected: ['no_newsletter'] },
      'no_newsletter', CONFLICT('NOTIFICATION_OPT_OUT_UNAVAILABLE'), null],
    ['a negated notification checkbox in Japanese', {
      fields: [sampleField('メール配信不要', 'checkbox', { options: ['1'] })], selected: ['メール配信不要'],
    }, 'メール配信不要', CONFLICT('NOTIFICATION_OPT_OUT_UNAVAILABLE'), null],
    ['a negated notification checkbox with opt_out', {
      fields: [sampleField('sms_opt_out', 'checkbox', { options: ['on'] })], selected: ['sms_opt_out'],
    }, 'sms_opt_out', CONFLICT('NOTIFICATION_OPT_OUT_UNAVAILABLE'), null],
    ['a negated notification select', {
      fields: [sampleField('notify_not', 'select-one', { options: ['yes', 'no'] })], selected: ['notify_not'],
    }, 'notify_not', CONFLICT('NOTIFICATION_OPT_OUT_UNAVAILABLE'), null],
    ['a negated notification checkbox with a human fixed value', {
      fields: [sampleField('no_newsletter', 'checkbox', { options: ['1'] })], selected: ['no_newsletter'],
      rules: [sampleFieldRule('no_newsletter', { semanticKind: 'FIXED_LIST', method: 'FROM_FIXED_LIST', fixedValues: ['1'] })],
    }, 'no_newsletter', null, 'HUMAN'],
    ['a negated notification checkbox with a human value outside the options', {
      fields: [sampleField('no_newsletter', 'checkbox', { options: ['1'] })], selected: ['no_newsletter'],
      rules: [sampleFieldRule('no_newsletter', { semanticKind: 'FIXED_LIST', method: 'FROM_FIXED_LIST', fixedValues: ['2'] })],
    }, 'no_newsletter', CONFLICT('FIXED_VALUE_VIOLATES_CONSTRAINT'), 'HUMAN'],
    ['a notification checkbox needs no confirmation (nothing is sent)', {
      fields: [sampleField('notify', 'checkbox', { options: ['1'] })], selected: ['notify'], confirmed: false,
    }, 'notify', null, 'OPT_OUT'],
    // 状態・送れない欄・既定の値
    ['a state field', { fields: [sampleField('status', 'select-one', { options: ['a', 'b'] })], selected: ['status'] }, 'status',
      CONFLICT('STATE_FIELD_NOT_USABLE'), null],
    ['a hidden field', { fields: [sampleField('name', 'hidden', { hasValue: true })], selected: ['name'] }, 'name',
      CONFLICT('FIELD_NOT_SENDABLE'), null],
    ['a password field', { fields: [sampleField('note', 'password')], selected: ['note'] }, 'note', CONFLICT('FIELD_NOT_SENDABLE'), null],
    ['a file field', { fields: [sampleField('note', 'file')], selected: ['note'] }, 'note', CONFLICT('FIELD_NOT_SENDABLE'), null],
    ['a field missing from the candidate', { fields: [sampleField('name')], selected: ['name', 'other'] }, 'other', CONFLICT('FIELD_NOT_SENDABLE'),
      null],
    ['a field with a default value (overwritten on CREATE)', {
      fields: [sampleField('name', 'text', { hasValue: true })], selected: ['name'],
    }, 'name', null, 'TEMPLATE'],
    // required の未選択
    ['a required field that is not selected', {
      fields: [sampleField('name'), sampleField('code_x', 'text', { required: true })], selected: ['name'],
    }, 'code_x', NEEDS('REQUIRED_FIELD_NOT_SELECTED'), null],
  ])('%s', (_label, testCase, name, problem, source) => {
    const evaluation = fieldOf(evaluate(testCase), name);
    expect({ problem: evaluation.problem, source: evaluation.source }).toEqual({ problem, source });
    expect(evaluation.status).toBe(problem === null ? 'DECIDED' : problem.code);
  });
});

describe('evaluateRuleSet: relations, executability and the shape (T29c)', () => {
  const reservation: readonly CandidateField[] = [
    withConstraints(sampleField('start_time', 'time'), { min: '18:00', max: '20:00' }),
    withConstraints(sampleField('end_time', 'time'), { min: '09:00', max: '10:00' }),
  ];

  it('stops a relation that cannot hold in the ranges', () => {
    const result = evaluate({ fields: reservation, selected: ['end_time', 'start_time'] });
    expect(fieldOf(result, 'end_time').problem).toEqual(CONFLICT('RELATION_UNSATISFIABLE'));
    expect(result.relations).toEqual([{ kind: 'END_AFTER_START', startFieldName: 'start_time', endFieldName: 'end_time' }]);
    expect(result.executable).toBe(false);
  });

  it('stops a relation between fields of the wrong kinds', () => {
    const result = evaluate({
      fields: [sampleField('name'), sampleField('note', 'textarea')],
      selected: ['name', 'note'],
      relations: [{ kind: 'KANA_MATCHES_NAME', nameFieldName: 'name', kanaFieldName: 'note' }],
    });
    expect(fieldOf(result, 'note').problem).toEqual(CONFLICT('RELATION_FIELD_MISMATCH'));
  });

  it('stops a total of a choice field', () => {
    const result = evaluate({
      fields: [sampleField('price', 'number'), sampleField('quantity', 'number'), sampleField('total', 'select-one', { options: ['100'] })],
      selected: ['price', 'quantity', 'total'],
    });
    expect(fieldOf(result, 'total').problem).toEqual(CONFLICT('RELATION_UNSATISFIABLE'));
  });

  it('is executable when every selected field is decided, and returns frozen results in the name order', () => {
    const result = evaluate({
      fields: [sampleField('name'), sampleField('name_kana'), sampleField('email', 'email'), sampleField('tel', 'tel'), sampleField('note', 'textarea'),
        sampleField('price', 'number'), sampleField('quantity', 'number'), sampleField('total', 'number'),
        withConstraints(sampleField('start_time', 'time'), { min: '09:00', max: '18:00' }),
        withConstraints(sampleField('end_time', 'time'), { min: '09:00', max: '18:00' }), sampleField('notify', 'checkbox', { options: ['1'] })],
      selected: ['name', 'name_kana', 'email', 'tel', 'note', 'price', 'quantity', 'total', 'start_time', 'end_time', 'notify'],
    });
    expect(result.fields.filter((field) => field.status !== 'DECIDED')).toEqual([]);
    expect(result.executable).toBe(true);
    expect(result.fields.map((field) => field.fieldName)).toEqual(['email', 'end_time', 'name', 'name_kana', 'note', 'notify', 'price', 'quantity',
      'start_time', 'tel', 'total']);
    expect(result.uniqueKeyFieldNames).toEqual(['name', 'name_kana']);
    expect(result.relations.map((relation) => relation.kind)).toEqual(['END_AFTER_START', 'TOTAL_EQUALS_UNIT_PRICE_TIMES_QUANTITY',
      'KANA_MATCHES_NAME']);
    expect(Object.isFrozen(result) && Object.isFrozen(result.fields) && Object.isFrozen(result.fields[0])).toBe(true);
  });

  it('keeps the human unique key fields and relations', () => {
    const candidate = candidateWith([sampleField('name'), sampleField('note', 'textarea')]);
    const scenario = scenarioFor(candidate, ['name', 'note']);
    const result = evaluateRuleSet(ruleSetFor(scenario, [], { uniqueKeyFieldNames: ['note'] }), scenario, candidate);
    expect(result.uniqueKeyFieldNames).toEqual(['note']);
  });

  it('rejects a rule set of another scenario and a candidate of another identity (caller errors)', () => {
    const candidate = candidateWith([sampleField('name')]);
    const scenario = scenarioFor(candidate, ['name']);
    expect(() => evaluateRuleSet(ruleSetFor(scenario, [], { scenarioId: 'scenario-2' }), scenario, candidate)).toThrow(RangeError);
    expect(() => evaluateRuleSet(ruleSetFor(scenario), scenario, candidateWith([sampleField('other')]))).toThrow(RangeError);
  });

  it('evaluates with the notification confirmation of the scenario only', () => {
    expect(evaluate({ fields: [sampleField('email', 'email')], selected: ['email'], confirmed: true }).executable).toBe(true);
    expect(evaluate({ fields: [sampleField('email', 'email')], selected: ['email'], confirmed: false }).executable).toBe(false);
    expect(ALL_CONFIRMED.NO_EXTERNAL_NOTIFICATION).toBe(true);
  });
});

// MI-6（設計書 `2026-10-26-beaksight-minimal-input-ux-design.md` 4.6、ユーザーの判断 2）: 副作用の確認は承認のダイアログの 1 回にまとめた。承認の前の
// 画面は「承認のときに確認する」前提（`EXTERNAL_NOTIFICATION_AT_APPROVAL`）で判定し、メール・電話の欄を作れる欄として、印を付けて返す。前提を渡さない
// 判定（承認と書き込みの開始の確かめ）は、今どおり版の確認の値だけを見る。
describe('evaluateRuleSet: the premise that the approval confirms the notification (MI-6)', () => {
  const unconfirmed = (premise: Parameters<typeof evaluateRuleSet>[3]) => {
    const candidate = candidateWith([sampleField('email', 'email'), sampleField('tel', 'tel'), sampleField('name')]);
    const scenario = scenarioFor(candidate, ['email', 'tel', 'name'], { sideEffectConfirmations: NOTIFICATION_UNCONFIRMED });
    return evaluateRuleSet(ruleSetFor(scenario), scenario, candidate, premise);
  };

  it('decides the email and phone fields with a mark under the premise, and keeps the other fields the same', () => {
    const result = unconfirmed({ notificationConfirmation: EXTERNAL_NOTIFICATION_AT_APPROVAL });
    expect(result.executable).toBe(true);
    expect(result.fields.map(({ fieldName, status, problem, confirmationAtApproval }) => [fieldName, status, problem, confirmationAtApproval ?? false]))
      .toEqual([
        ['email', 'DECIDED', null, true],
        ['name', 'DECIDED', null, false],
        ['tel', 'DECIDED', null, true],
      ]);
  });

  it('keeps the judgement by the confirmation of the scenario revision without the premise', () => {
    const result = unconfirmed(undefined);
    expect(result.executable).toBe(false);
    expect(fieldOf(result, 'email').problem).toEqual({ code: 'EXTERNAL_DELIVERY_BLOCKED', detail: 'EXTERNAL_NOTIFICATION_UNCONFIRMED' });
    expect(fieldOf(result, 'email').confirmationAtApproval).toBeUndefined();
  });

  it('adds no mark when the scenario revision has the confirmation', () => {
    const candidate = candidateWith([sampleField('email', 'email')]);
    const scenario = scenarioFor(candidate, ['email']);
    const result = evaluateRuleSet(ruleSetFor(scenario), scenario, candidate, { notificationConfirmation: EXTERNAL_NOTIFICATION_AT_APPROVAL });
    expect(fieldOf(result, 'email')).toMatchObject({ status: 'DECIDED' });
    expect(fieldOf(result, 'email').confirmationAtApproval).toBeUndefined();
  });
});

// MI-C2 項目 18: 承認の前の画面の判定の前提は、1 つの定数（`PRE_APPROVAL_EVALUATION_PREMISE`）だけで組む。画面のサーバの 3 か所（入力の規則の事実、シナリオの
// 詳細の推測の項目の求め直し、自動の下書きの推し）は、それを使う（同じ形のオブジェクトを書き写さない）。
describe('the premise of the screens before the approval (MI-C2)', () => {
  it('is one frozen constant with the premise that the approval confirms the notification', () => {
    expect(PRE_APPROVAL_EVALUATION_PREMISE).toEqual({ notificationConfirmation: EXTERNAL_NOTIFICATION_AT_APPROVAL });
    expect(Object.isFrozen(PRE_APPROVAL_EVALUATION_PREMISE)).toBe(true);
  });

  it('is used by the three server parts, and no one builds the same object again', () => {
    for (const path of [
      'apps/local-ui/src/server/data-rule-facts.ts',
      'apps/local-ui/src/server/scenario-functions.ts',
      'apps/local-ui/src/server/scenario-autodraft-functions.ts',
    ]) {
      const source = readFileSync(path, 'utf8');
      expect(source, path).toContain('PRE_APPROVAL_EVALUATION_PREMISE');
      expect(source, path).not.toMatch(/notificationConfirmation\s*:/u);
    }
  });
});
