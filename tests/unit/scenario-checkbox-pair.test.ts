// T31b fix round 1（Task 31 の設計書 3 章の「同じ名前の hidden と checkbox の組（Rails 型）」）: 欄の役割の判定（`scenario-policy.ts`）と、CREATE の
// 送る欄（下書きの確かめと、入力の規則の欄の判定 `src/control/data-rules/field-evaluation.ts`）で組を受ける。
// - 組の checkbox は「見えていて編集できる欄」: UPDATE では変える欄か保つ欄のどちらかの役割を持つ（持たなければ `SCENARIO_UPDATE_FIELD_ROLE_MISSING`）。
//   組の hidden は役割を持たない（組の一部。名前は checkbox と同じなので、名前の役割は checkbox のもの）。
// - 組でない同じ名前の欄（逆の順など）は、今どおり受けない（役割も求めない）。
// - CREATE: 組の checkbox を送る欄にできる。状態の欄の判定は変えない（UPDATE は保つだけ、CREATE の生成は `STATE_FIELD_NOT_USABLE`）。
// 例の値は、匿名の値（`127.0.0.1`）だけを使う。
import { describe, expect, it } from 'vitest';
import type { ScenarioKindFact } from '../../src/control/approval/scenario-contracts.js';
import { validateScenarioDraft, type ScenarioDraftValidationResult } from '../../src/control/approval/scenario-policy.js';
import { evaluateRuleSet } from '../../src/control/data-rules/field-evaluation.js';
import type { CandidateField, DiscoveredCandidate, DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { PROFILE_ID, READ_CHECK_FACTS, candidateOf, sampleDraft } from './approval-samples.js';
import { candidateWith, ruleSetFor, scenarioFor } from './data-rule-scenario-samples.js';
import { SAMPLE_ORIGIN, sampleAction, sampleField, sampleForm } from './discovery-candidate-samples.js';

const codesOf = (result: ScenarioDraftValidationResult): readonly (readonly [string, string | null])[] =>
  (result.ok ? [] : result.errors.map(({ code, fieldName }) => [code, fieldName] as const));

const hidden = (name: string): CandidateField => sampleField(name, 'hidden', { hasValue: true });
const checkbox = (name: string): CandidateField => sampleField(name, 'checkbox');

/** 組（featured、active）と、組でない同じ名前の欄（逆の順の hidden。`ordered`）を持つ更新の画面。 */
const PAIR_FIELDS = [
  sampleField('name', 'text', { required: true }),
  hidden('featured'),
  checkbox('featured'),
  hidden('active'),
  checkbox('active'),
  checkbox('ordered'),
  hidden('ordered'),
  sampleField('_method', 'hidden', { hasValue: true }),
];

const editCandidate = (fields: readonly CandidateField[] = PAIR_FIELDS, overrides: Partial<DiscoveredCandidate> = {}): DiscoveryCandidate =>
  candidateOf(sampleForm({
    page: { origin: SAMPLE_ORIGIN, path: '/members/7/edit' },
    action: sampleAction('/members/7'),
    methodOverride: 'PATCH',
    submitterText: '更新',
    fields,
    ...overrides,
  }));

const EDIT = editCandidate();
const SCENARIOS: readonly ScenarioKindFact[] = [{ scenarioId: 'scenario-create', profileId: PROFILE_ID, kind: 'CREATE' }];

const updateDraft = (fieldNames: readonly string[], keepFieldNames: readonly string[]): Record<string, unknown> => sampleDraft({
  candidateIdentityDigest: EDIT.identityDigest,
  fieldNames,
  readChecks: [],
  update: { targetCreateScenarioId: 'scenario-create', formPathTemplate: '/members/{id}/edit', actionPathTemplate: '/members/{id}', keepFieldNames },
});

const validateUpdate = (fieldNames: readonly string[], keepFieldNames: readonly string[]) =>
  validateScenarioDraft(updateDraft(fieldNames, keepFieldNames), EDIT, [], { scenarioId: 'scenario-update', scenarios: SCENARIOS });

describe('T31b fix round 1: field roles with a pair of a hidden field and a checkbox', () => {
  it('needs a role for the checkbox of a pair, and accepts it as a field to keep or to change', () => {
    expect(EDIT.classification).toBe('UPDATE');
    expect(codesOf(validateUpdate(['name'], ['active']))).toEqual([['SCENARIO_UPDATE_FIELD_ROLE_MISSING', 'featured']]);
    expect(codesOf(validateUpdate(['name'], ['active', 'featured']))).toEqual([]);
    expect(codesOf(validateUpdate(['featured', 'name'], ['active']))).toEqual([]);
  });

  it('keeps a state field of a pair only (it is never a field to change)', () => {
    expect(codesOf(validateUpdate(['active', 'name'], ['featured']))).toEqual([['SCENARIO_STATE_FIELD_NOT_CHANGEABLE', 'active']]);
  });

  it('rejects a role for fields of the same name that are not a pair, and does not need one for them', () => {
    expect(codesOf(validateUpdate(['name'], ['active', 'featured', 'ordered']))).toEqual([['SCENARIO_FIELD_NOT_ALLOWED', 'ordered']]);
    expect(codesOf(validateUpdate(['name', 'ordered'], ['active', 'featured']))).toEqual([['SCENARIO_FIELD_NOT_ALLOWED', 'ordered']]);
  });

  it('rejects a role for a hidden field that is not a part of a pair', () => {
    const fields = [...PAIR_FIELDS, hidden('lock_version')];
    const candidate = editCandidate(fields);
    const draft = { ...updateDraft(['name'], ['active', 'featured', 'lock_version']), candidateIdentityDigest: candidate.identityDigest };
    expect(codesOf(validateScenarioDraft(draft, candidate, [], { scenarioId: 'scenario-update', scenarios: SCENARIOS })))
      .toEqual([['SCENARIO_FIELD_NOT_ALLOWED', 'lock_version']]);
  });

  it('does not accept the checkbox of a pair that cannot be edited (readonly or disabled)', () => {
    const fields = [sampleField('name'), hidden('featured'), sampleField('featured', 'checkbox', { disabled: true })];
    const candidate = editCandidate(fields);
    const draft = { ...updateDraft(['name'], ['featured']), candidateIdentityDigest: candidate.identityDigest };
    expect(codesOf(validateScenarioDraft(draft, candidate, [], { scenarioId: 'scenario-update', scenarios: SCENARIOS })))
      .toEqual([['SCENARIO_FIELD_NOT_ALLOWED', 'featured']]);
  });
});

describe('T31b fix round 1: the checkbox of a pair as a field to send of a CREATE scenario', () => {
  const CREATE = candidateWith([sampleField('name', 'text', { required: true }), hidden('featured'), checkbox('featured'), hidden('active'), checkbox('active')]);

  it('accepts the checkbox of a pair in the draft of a CREATE scenario, and still rejects fields of the same name that are not a pair', () => {
    expect(CREATE.classification).toBe('CREATE');
    const draft = sampleDraft({ candidateIdentityDigest: CREATE.identityDigest, fieldNames: ['featured', 'name'] });
    expect(codesOf(validateScenarioDraft(draft, CREATE, READ_CHECK_FACTS))).toEqual([]);
    const reversed = candidateWith([sampleField('name'), checkbox('featured'), hidden('featured')]);
    const reversedDraft = sampleDraft({ candidateIdentityDigest: reversed.identityDigest, fieldNames: ['featured', 'name'] });
    expect(codesOf(validateScenarioDraft(reversedDraft, reversed, READ_CHECK_FACTS))).toEqual([['SCENARIO_FIELD_NOT_ALLOWED', 'featured']]);
  });

  it('decides the checkbox of a pair in the input rules, and keeps the state field judgement', () => {
    const scenario = scenarioFor(CREATE, ['active', 'featured', 'name']);
    const fields = evaluateRuleSet(ruleSetFor(scenario), scenario, CREATE).fields;
    const problemOf = (fieldName: string) => fields.find((field) => field.fieldName === fieldName)?.problem;
    expect(problemOf('featured')).toBeNull();
    expect(problemOf('active')).toEqual({ code: 'RULE_CONFLICT', detail: 'STATE_FIELD_NOT_USABLE' });
    const reversed = candidateWith([sampleField('name'), checkbox('featured'), hidden('featured')]);
    const reversedScenario = scenarioFor(reversed, ['featured', 'name']);
    expect(evaluateRuleSet(ruleSetFor(reversedScenario), reversedScenario, reversed).fields.find((field) => field.fieldName === 'featured')?.problem)
      .toEqual({ code: 'RULE_CONFLICT', detail: 'FIELD_NOT_SENDABLE' });
  });
});
