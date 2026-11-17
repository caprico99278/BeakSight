// OP-2（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D10、規則 F）: 更新で変える欄を BeakSight が決める決まり
// （`src/control/approval/update-changed-field.ts` と、フォームの形の下書きの計画 `formAutoDraftPlanOf`）。
// - 規則 F: 値が決まり毎回変わる、ふつうの文字の欄（外部へ届く語でない）から、登録で送った欄 → 登録の画面にある欄 → ほかの欄、の順に 1 つ選ぶ。
//   ほかの見えていて編集できる欄は保つ欄にする。選べなければ理由（`UPDATE_CHANGED_FIELD_NOT_FOUND`）。
// - テンプレートの外の文字の欄（名前が業務の語に当たらない欄）は、汎用の作り物の文字の規則（`GENERIC_TEXT`）で値が決まる。
import { describe, expect, it } from 'vitest';
import { formAutoDraftPlanOf, formUpdateChangedFieldOf } from '../../src/control/approval/form-scenario-autodraft.js';
import { chooseUpdateChangedField, type UpdateChangedFieldFact } from '../../src/control/approval/update-changed-field.js';
import type { ScenarioDraftContext } from '../../src/control/approval/scenario-policy.js';
import { inferRuleSetContent } from '../../src/control/data-rules/rule-set-inference.js';
import { generateScenarioData } from '../../src/control/data-rules/scenario-data.js';
import { BASE_DATE, candidateWith, ruleSetFor, scenarioFor, seedInputFor } from './data-rule-scenario-samples.js';
import { CREATE_CANDIDATE, PROFILE_ID, candidateOf } from './approval-samples.js';
import { SAMPLE_ORIGIN, sampleAction, sampleField, sampleForm } from './discovery-candidate-samples.js';

const CONTEXT: ScenarioDraftContext = Object.freeze({
  scenarioId: null,
  scenarios: Object.freeze([]),
  profileRevisions: Object.freeze({ discoveryJob: 2, current: 2 }),
}) as ScenarioDraftContext;

const fact = (name: string, overrides: Partial<UpdateChangedFieldFact> = {}): UpdateChangedFieldFact => ({
  name, usable: true, sentInLedger: false, onCreateScreen: false, ...overrides,
});

/** 会員の更新の画面（名前・メール・備考・テンプレートの外の文字の欄・通知の checkbox・状態の hidden）。 */
const MEMBER_UPDATE = candidateOf(sampleForm({
  page: { origin: SAMPLE_ORIGIN, path: '/members/1/edit' },
  action: sampleAction('/members/1'),
  methodOverride: 'PATCH',
  submitterText: '更新',
  fields: [
    sampleField('email', 'email'),
    sampleField('nickname'),
    sampleField('note'),
    sampleField('name'),
    sampleField('newsletter', 'checkbox'),
    sampleField('_method', 'hidden', { hasValue: true }),
  ],
}));

describe('OP-2: rule F chooses the changed field of an update', () => {
  it('prefers a field sent by the create, then a field on the create screen, then any other usable field', () => {
    expect(chooseUpdateChangedField([fact('a'), fact('b', { onCreateScreen: true }), fact('c', { sentInLedger: true, onCreateScreen: true })]))
      .toEqual({ kind: 'CHOSEN', fieldName: 'c', ground: 'SENT_BY_CREATE' });
    expect(chooseUpdateChangedField([fact('a'), fact('b', { onCreateScreen: true })])).toEqual({ kind: 'CHOSEN', fieldName: 'b', ground: 'ON_CREATE_SCREEN' });
    expect(chooseUpdateChangedField([fact('a', { usable: false }), fact('b')])).toEqual({ kind: 'CHOSEN', fieldName: 'b', ground: 'OTHER_FIELD' });
    expect(chooseUpdateChangedField([fact('a', { usable: false, sentInLedger: true })])).toEqual({ kind: 'UNAVAILABLE', reason: 'UPDATE_CHANGED_FIELD_NOT_FOUND' });
    expect(chooseUpdateChangedField([])).toEqual({ kind: 'UNAVAILABLE', reason: 'UPDATE_CHANGED_FIELD_NOT_FOUND' });
  });

  it('picks a varying plain text field of a form update, keeping the other editable fields (not the email, not the notification)', () => {
    const chosen = formUpdateChangedFieldOf(PROFILE_ID, MEMBER_UPDATE, CREATE_CANDIDATE, ['name']);
    expect(chosen).toMatchObject({ kind: 'CHOSEN', changedFieldNames: ['name'], ground: 'SENT_BY_CREATE' });
    expect(chosen.kind === 'CHOSEN' ? [...chosen.keepFieldNames].sort() : []).toEqual(['email', 'newsletter', 'nickname', 'note']);
    // 登録で送っていなければ、登録の画面にある欄（name は登録の画面にある）。
    expect(formUpdateChangedFieldOf(PROFILE_ID, MEMBER_UPDATE, CREATE_CANDIDATE, [])).toMatchObject({ changedFieldNames: ['name'], ground: 'ON_CREATE_SCREEN' });
    // 登録の画面が分からなければ、ほかの欄の順（候補の欄の順で最初の、使える欄。email は外部へ届くので選ばない）。
    expect(formUpdateChangedFieldOf(PROFILE_ID, MEMBER_UPDATE, null, null)).toMatchObject({ changedFieldNames: ['nickname'], ground: 'OTHER_FIELD' });
  });

  it('decides a field outside the templates with the generic fake text rule', () => {
    const titleOnly = candidateOf(sampleForm({
      page: { origin: SAMPLE_ORIGIN, path: '/topics/3/edit' },
      action: sampleAction('/topics/3'),
      methodOverride: 'PATCH',
      submitterText: '更新',
      fields: [sampleField('headline'), sampleField('_method', 'hidden', { hasValue: true })],
    }));
    expect(formUpdateChangedFieldOf(PROFILE_ID, titleOnly, null, null)).toMatchObject({ kind: 'CHOSEN', changedFieldNames: ['headline'] });
  });

  it('cannot choose when the update screen has only non-text or outgoing fields', () => {
    const noText = candidateOf(sampleForm({
      page: { origin: SAMPLE_ORIGIN, path: '/members/1/settings' },
      action: sampleAction('/members/1'),
      methodOverride: 'PATCH',
      submitterText: '更新',
      fields: [sampleField('email', 'email'), sampleField('newsletter', 'checkbox'), sampleField('_method', 'hidden', { hasValue: true })],
    }));
    expect(formUpdateChangedFieldOf(PROFILE_ID, noText, null, null)).toEqual({ kind: 'UNAVAILABLE', reason: 'UPDATE_CHANGED_FIELD_NOT_FOUND' });
  });

  it('plans the form update with the chosen fields instead of asking a person to choose', () => {
    const plan = formAutoDraftPlanOf({ profileId: PROFILE_ID, candidates: [CREATE_CANDIDATE, MEMBER_UPDATE], context: CONTEXT, scenarios: [] });
    expect(plan.updates.map((item) => item.status)).toEqual(['NEW']);
    const [update] = plan.updates;
    expect(update?.status === 'NEW' ? update.changedFieldNames : []).toEqual(['name']);
  });
});

/** R4 で、送らずに止まった回を重ねる数（やり直しの回数の見込みより十分に多い）。 */
const NOT_SENT_ATTEMPTS = 40;

describe('OP-2 R4: values of attempts stopped before sending stay in the history, and a retry still generates', () => {
  const run = (fieldName: string, uniqueKeyOf: (inferred: readonly string[]) => readonly string[]): readonly boolean[] => {
    const field = MEMBER_UPDATE.fields.find(({ name }) => name === fieldName);
    if (field === undefined) throw new Error(`no field ${fieldName}`);
    const candidate = candidateWith([field]);
    const scenario = scenarioFor(candidate, [fieldName]);
    const inferred = inferRuleSetContent(scenario, candidate);
    const ruleSet = ruleSetFor(scenario, inferred.content.fieldRules, {
      relations: [], uniqueKeyFieldNames: [...uniqueKeyOf(inferred.content.uniqueKeyFieldNames)], templateDefaultsSaved: true,
    });
    const used: string[] = [];
    const generated: boolean[] = [];
    for (let attempt = 0; attempt < NOT_SENT_ATTEMPTS; attempt += 1) {
      const result = generateScenarioData({
        ruleSet, scenario, candidate, seedInput: seedInputFor(scenario, ruleSet, `grant-${attempt}`), usedUniqueKeys: used, usedPhoneNumbers: [], baseDate: BASE_DATE,
      });
      generated.push(result.ok);
      if (result.ok && result.uniqueKey !== null) used.push(result.uniqueKey);
    }
    return generated;
  };

  it.each([['nickname'], ['name'], ['note']])('keeps generating the field %s chosen by rule F with the inferred unique key', (fieldName) => {
    expect(run(fieldName, (inferred) => inferred).every(Boolean)).toBe(true);
  });

  it.each([['nickname'], ['name']])('keeps generating %s even when the field itself must be unique (no value twice)', (fieldName) => {
    expect(run(fieldName, () => [fieldName]).every(Boolean)).toBe(true);
  });
});
