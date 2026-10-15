// T31b（Task 31 の設計書 2 章のユーザーの判断 1〜5、3 章の「UPDATE の指定」「削除にあたる変更の遮断」、4 章の「契約」、11 章の T31b の Blocker
// の判断）: UPDATE の指定の契約（`scenario-contracts.ts`）と、下書きの確かめ（`scenario-policy.ts` の `validateScenarioDraft`）。
// - UPDATE の指定（台帳の参照、更新の画面と送信先の path の型、保つ欄）は、kind が `UPDATE` の下書きで必須、`CREATE` は持てない。
// - path の型: `{id}` はそれぞれちょうど 1 つ、区切りの全体（形の誤りは `SCENARIO_INPUT_INVALID`）。型に候補の同じ位置の区切りの値を入れると、
//   画面の path と送信先の path の両方に同じ値で戻る。その値はレコードの ID の形に合う（判定は `action-outcome.ts` の `usableRecordIdOf`）。
// - 欄の役割: 見えていて編集できる欄は、すべて変える欄か保つ欄のどちらか 1 つ。変える欄は 1 つ以上。状態の欄・危険な語・秘密に見える名前は変える
//   欄にできない。秘密に見える名前の見える欄がある画面は、UPDATE の指定を受けない。
// - 台帳の参照: 同じプロファイルの、自分でない `CREATE` のシナリオ。
// - 中身には、候補から求めた型にした識別の digest（`fingerprint.ts`）を持つ（承認の有効性は、これで判定する）。
// 例の値は、匿名の値（`127.0.0.1`）だけを使う。
import { describe, expect, it } from 'vitest';
import { MAX_SCENARIO_KEEP_FIELD_NAMES, type ScenarioKindFact } from '../../src/control/approval/scenario-contracts.js';
import {
  NO_SCENARIO_DRAFT_CONTEXT,
  SCENARIO_DRAFT_REJECTION_REASONS,
  isUpdatePathBoundToLedger,
  validateScenarioDraft,
  type ScenarioDraftContext,
  type ScenarioDraftValidationResult,
} from '../../src/control/approval/scenario-policy.js';
import type { DiscoveredCandidate, DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { MAX_CANDIDATE_FIELDS } from '../../src/discovery/candidate-contracts.js';
import { recordIdSegmentPairOfTemplates, templatedIdentityDigestOf } from '../../src/discovery/fingerprint.js';
import { isSecretLikeStateField } from '../../src/discovery/read-check-contracts.js';
import { CREATE_CANDIDATE, OTHER_PROFILE_ID, PROFILE_ID, READ_CHECK_FACTS, candidateOf, sampleDraft } from './approval-samples.js';
import { SAMPLE_ORIGIN, sampleAction, sampleField, sampleForm } from './discovery-candidate-samples.js';

const codesOf = (result: ScenarioDraftValidationResult): readonly string[] => (result.ok ? [] : result.errors.map(({ code }) => code));
const errorsOf = (result: ScenarioDraftValidationResult) => (result.ok ? [] : result.errors);

const FORM_TEMPLATE = '/members/{id}/edit';
const ACTION_TEMPLATE = '/members/{id}';

/** 見えていて編集できる欄（name・email・note・status）と、役割を持たない欄（hidden・readonly・disabled・file・password・`_method`）。 */
const EDIT_FIELDS = [
  sampleField('name', 'text', { required: true }),
  sampleField('email', 'email'),
  sampleField('note', 'textarea'),
  sampleField('status', 'select-one', { options: ['active', 'closed'] }),
  sampleField('lock_version', 'hidden', { hasValue: true }),
  sampleField('code_name', 'text', { readonly: true }),
  sampleField('locked', 'text', { disabled: true }),
  sampleField('avatar', 'file'),
  sampleField('pin', 'password'),
  sampleField('_method', 'hidden', { hasValue: true }),
];

/** レコード `id` の更新の画面の候補（PATCH）。 */
const editCandidate = (id = '7', overrides: Partial<DiscoveredCandidate> = {}): DiscoveryCandidate => candidateOf(sampleForm({
  page: { origin: SAMPLE_ORIGIN, path: `/members/${id}/edit` },
  action: sampleAction(`/members/${id}`),
  methodOverride: 'PATCH',
  submitterText: '更新',
  fields: EDIT_FIELDS,
  ...overrides,
}));

const EDIT_CANDIDATE = editCandidate();

/** 同じプロファイルとほかのプロファイルのシナリオ（id・プロファイル・kind）。 */
const SCENARIO_FACTS: readonly ScenarioKindFact[] = Object.freeze([
  { scenarioId: 'scenario-create', profileId: PROFILE_ID, kind: 'CREATE' },
  { scenarioId: 'scenario-update-other', profileId: PROFILE_ID, kind: 'UPDATE' },
  { scenarioId: 'scenario-foreign', profileId: OTHER_PROFILE_ID, kind: 'CREATE' },
]);
const CONTEXT: ScenarioDraftContext = Object.freeze({ scenarioId: 'scenario-update', scenarios: SCENARIO_FACTS });

const UPDATE_SPEC = Object.freeze({
  targetCreateScenarioId: 'scenario-create',
  formPathTemplate: FORM_TEMPLATE,
  actionPathTemplate: ACTION_TEMPLATE,
  keepFieldNames: ['status', 'email', 'note'],
});

/** UPDATE の下書き（受ける形）。 */
const updateDraft = (overrides: Record<string, unknown> = {}, update: Record<string, unknown> = {}): Record<string, unknown> => sampleDraft({
  candidateIdentityDigest: EDIT_CANDIDATE.identityDigest,
  fieldNames: ['name'],
  readChecks: [],
  update: { ...UPDATE_SPEC, ...update },
  ...overrides,
});

const validate = (draft: unknown, candidate: DiscoveryCandidate | null = EDIT_CANDIDATE, context: ScenarioDraftContext = CONTEXT) =>
  validateScenarioDraft(draft, candidate, [], context);

describe('UPDATE spec contracts (T31b)', () => {
  it('adds the reasons of the UPDATE spec to the closed list of the draft rejection reasons, all starting with SCENARIO_', () => {
    expect(SCENARIO_DRAFT_REJECTION_REASONS).toEqual(expect.arrayContaining([
      'SCENARIO_UPDATE_SPEC_MISSING',
      'SCENARIO_UPDATE_SPEC_NOT_ALLOWED',
      'SCENARIO_UPDATE_PATH_MISMATCH',
      'SCENARIO_UPDATE_RECORD_ID_UNSAFE',
      'SCENARIO_UPDATE_FIELD_ROLE_OVERLAP',
      'SCENARIO_UPDATE_FIELD_ROLE_MISSING',
      'SCENARIO_UPDATE_NO_CHANGED_FIELD',
      'SCENARIO_STATE_FIELD_NOT_CHANGEABLE',
      'SCENARIO_UPDATE_FORM_HAS_SECRET_LIKE_FIELD',
      // T31e fix round 1。
      'SCENARIO_UPDATE_FORM_HAS_SECRET_LIKE_STATE_FIELD',
      'SCENARIO_UPDATE_TARGET_NOT_FOUND',
      'SCENARIO_UPDATE_TARGET_NOT_CREATE',
      // T31R-fix-1 の I-1。
      'SCENARIO_REMOVAL_FIELD_NOT_CHANGEABLE',
      // T31R-fix-1 の I-2。
      'SCENARIO_UPDATE_PATH_NOT_BOUND_TO_LEDGER_ID',
    ]));
    expect(SCENARIO_DRAFT_REJECTION_REASONS.every((reason) => reason.startsWith('SCENARIO_'))).toBe(true);
    expect(MAX_SCENARIO_KEEP_FIELD_NAMES).toBe(MAX_CANDIDATE_FIELDS);
    expect(NO_SCENARIO_DRAFT_CONTEXT).toEqual({ scenarioId: null, scenarios: [] });
    expect(Object.isFrozen(NO_SCENARIO_DRAFT_CONTEXT)).toBe(true);
  });
});

describe('UPDATE spec in the draft validation (T31b)', () => {
  it('accepts an UPDATE draft and keeps the spec with the templated identity digest of the candidate (keep fields in code unit order)', () => {
    const result = validate(updateDraft());
    expect(codesOf(result)).toEqual([]);
    const pair = recordIdSegmentPairOfTemplates(FORM_TEMPLATE, ACTION_TEMPLATE);
    expect(pair).not.toBeNull();
    if (result.ok && pair !== null) {
      expect(result.content.kind).toBe('UPDATE');
      expect(result.content.update).toEqual({
        targetCreateScenarioId: 'scenario-create',
        formPathTemplate: FORM_TEMPLATE,
        actionPathTemplate: ACTION_TEMPLATE,
        keepFieldNames: ['email', 'note', 'status'],
        templatedIdentityDigest: templatedIdentityDigestOf(EDIT_CANDIDATE, pair),
      });
      expect(Object.isFrozen(result.content.update)).toBe(true);
      // 別のレコードの画面の候補でも、型にした識別の digest は同じ。
      const other = validate(updateDraft({ candidateIdentityDigest: editCandidate('8').identityDigest }), editCandidate('8'));
      expect(other.ok && other.content.update?.templatedIdentityDigest).toBe(result.content.update?.templatedIdentityDigest);
    }
  });

  it('keeps the CREATE content without an UPDATE spec (null), with or without an explicit null', () => {
    for (const draft of [sampleDraft(), sampleDraft({ update: null })]) {
      const result = validateScenarioDraft(draft, CREATE_CANDIDATE, READ_CHECK_FACTS);
      expect(codesOf(result)).toEqual([]);
      expect(result.ok && result.content.update).toBeNull();
    }
  });

  it('requires the UPDATE spec for an UPDATE candidate and rejects it for a CREATE candidate', () => {
    expect(codesOf(validate(updateDraft({ update: undefined })))).toEqual(['SCENARIO_UPDATE_SPEC_MISSING']);
    const { update: _omitted, ...withoutUpdate } = updateDraft();
    expect(codesOf(validate(withoutUpdate))).toEqual(['SCENARIO_UPDATE_SPEC_MISSING']);
    expect(codesOf(validate(updateDraft({ update: null })))).toEqual(['SCENARIO_UPDATE_SPEC_MISSING']);
    expect(codesOf(validateScenarioDraft(sampleDraft({ update: UPDATE_SPEC }), CREATE_CANDIDATE, READ_CHECK_FACTS, CONTEXT)))
      .toEqual(['SCENARIO_UPDATE_SPEC_NOT_ALLOWED']);
  });

  it.each([
    ['no placeholder in the form template', { formPathTemplate: '/members/7/edit' }],
    ['two placeholders in the action template', { actionPathTemplate: '/members/{id}/{id}' }],
    ['a placeholder inside a segment', { formPathTemplate: '/members/x{id}/edit' }],
    ['a query in the template', { actionPathTemplate: '/members/{id}?back=1' }],
    ['a template without a leading slash', { formPathTemplate: 'members/{id}/edit' }],
    ['a template above the length limit', { formPathTemplate: `/${'a'.repeat(2048)}/{id}` }],
    ['a target id of another form', { targetCreateScenarioId: 'Scenario Create' }],
    ['a duplicate keep field', { keepFieldNames: ['email', 'email', 'note', 'status'] }],
    ['an empty keep field name', { keepFieldNames: ['email', '', 'note', 'status'] }],
    ['an unknown property', { extra: true }],
  ])('rejects the shape of the spec as SCENARIO_INPUT_INVALID (%s)', (_label, change) => {
    expect(codesOf(validate(updateDraft({}, change)))).toEqual(['SCENARIO_INPUT_INVALID']);
  });

  it('rejects a spec that is not an object and a missing item as SCENARIO_INPUT_INVALID', () => {
    expect(codesOf(validate(updateDraft({ update: 'spec' })))).toEqual(['SCENARIO_INPUT_INVALID']);
    const { keepFieldNames: _omitted, ...withoutKeep } = UPDATE_SPEC;
    const codes = codesOf(validate(updateDraft({ update: withoutKeep })));
    expect(codes.length).toBeGreaterThan(0);
    expect(new Set(codes)).toEqual(new Set(['SCENARIO_INPUT_INVALID']));
  });

  it.each([
    ['another segment of the form path', { formPathTemplate: '/staff/{id}/edit' }],
    ['another segment of the action path', { actionPathTemplate: '/people/{id}' }],
    ['another number of segments', { formPathTemplate: '/members/{id}' }],
    ['two different values for the placeholder', { formPathTemplate: '/{id}/7/edit' }],
  ])('rejects templates that do not give back the paths of the candidate with the same value (%s)', (_label, change) => {
    expect(codesOf(validate(updateDraft({}, change)))).toEqual(['SCENARIO_UPDATE_PATH_MISMATCH']);
  });

  it('rejects a record id outside the record id form', () => {
    const longId = '1'.repeat(300);
    const candidate = editCandidate(longId);
    expect(codesOf(validate(updateDraft({ candidateIdentityDigest: candidate.identityDigest }), candidate)))
      .toEqual(['SCENARIO_UPDATE_RECORD_ID_UNSAFE']);
  });

  it('requires a role for every visible editable field, at most one role per field, and at least one field to change', () => {
    const overlap = errorsOf(validate(updateDraft({ fieldNames: ['name', 'email'] })));
    expect(overlap.map(({ code, fieldName }) => [code, fieldName])).toEqual([['SCENARIO_UPDATE_FIELD_ROLE_OVERLAP', 'email']]);
    const missing = errorsOf(validate(updateDraft({}, { keepFieldNames: ['status'] })));
    expect(missing.map(({ code, fieldName }) => [code, fieldName])).toEqual([
      ['SCENARIO_UPDATE_FIELD_ROLE_MISSING', 'email'],
      ['SCENARIO_UPDATE_FIELD_ROLE_MISSING', 'note'],
    ]);
    expect(codesOf(validate(updateDraft({ fieldNames: [] }, { keepFieldNames: ['email', 'name', 'note', 'status'] }))))
      .toEqual(['SCENARIO_UPDATE_NO_CHANGED_FIELD']);
  });

  it.each(['lock_version', 'code_name', 'locked', 'avatar', 'pin', '_method', 'unknown'])(
    'rejects a keep field that is not a visible editable field of the candidate (%s)',
    (name) => {
      const errors = errorsOf(validate(updateDraft({}, { keepFieldNames: [...UPDATE_SPEC.keepFieldNames, name] })));
      expect(errors.map(({ code, fieldName }) => [code, fieldName])).toEqual([['SCENARIO_FIELD_NOT_ALLOWED', name]]);
    },
  );

  it('never changes a state field (it can only be kept)', () => {
    const errors = errorsOf(validate(updateDraft({ fieldNames: ['name', 'status'] }, { keepFieldNames: ['email', 'note'] })));
    expect(errors.map(({ code, fieldName }) => [code, fieldName])).toEqual([['SCENARIO_STATE_FIELD_NOT_CHANGEABLE', 'status']]);
  });

  it('never changes a field with a dangerous word, and keeps it allowed as a field to keep', () => {
    const candidate = editCandidate('7', { fields: [...EDIT_FIELDS, sampleField('delete_flag', 'checkbox')] });
    const base = { candidateIdentityDigest: candidate.identityDigest };
    const changed = errorsOf(validate(updateDraft({ ...base, fieldNames: ['name', 'delete_flag'] }), candidate));
    // 状態の欄の語（T31a が足す語を含む）にも当たるときは、状態の欄の誤りも出る（どちらも、変える欄にできない理由）。
    expect(changed.map(({ code, fieldName }) => [code, fieldName])).toContainEqual(['SCENARIO_FIELD_DANGEROUS_WORD', 'delete_flag']);
    expect(changed.every(({ fieldName }) => fieldName === 'delete_flag')).toBe(true);
    expect(codesOf(validate(updateDraft(base, { keepFieldNames: [...UPDATE_SPEC.keepFieldNames, 'delete_flag'] }), candidate))).toEqual([]);
  });

  // T31R-fix-1 の I-1: 危険な語・削除の語に当たる名前の欄（`fieldNameHasRemovalWord`）は、状態の欄と同じく保つだけ。
  it.each(['is_removed', 'trashed', 'withdrawn', 'void', 'unsubscribed', 'locked', 'banned'])(
    'never changes a field with a removal word (%s), and keeps it allowed as a field to keep',
    (name) => {
      const candidate = editCandidate('7', { fields: [...EDIT_FIELDS.filter((field) => field.name !== name), sampleField(name, 'checkbox')] });
      const base = { candidateIdentityDigest: candidate.identityDigest };
      const changed = errorsOf(validate(updateDraft({ ...base, fieldNames: ['name', name] }), candidate));
      expect(changed.map(({ code, fieldName }) => [code, fieldName])).toEqual([['SCENARIO_REMOVAL_FIELD_NOT_CHANGEABLE', name]]);
      expect(codesOf(validate(updateDraft(base, { keepFieldNames: [...UPDATE_SPEC.keepFieldNames, name] }), candidate))).toEqual([]);
    },
  );

  it('also marks a field with a dangerous word as a removal field (one shared judgement), besides the dangerous word of the field to send', () => {
    const candidate = editCandidate('7', { fields: [...EDIT_FIELDS, sampleField('_destroy', 'checkbox')] });
    const changed = errorsOf(validate(updateDraft({ candidateIdentityDigest: candidate.identityDigest, fieldNames: ['name', '_destroy'] }), candidate));
    expect(changed.map(({ code, fieldName }) => [code, fieldName])).toEqual([
      ['SCENARIO_FIELD_DANGEROUS_WORD', '_destroy'],
      ['SCENARIO_REMOVAL_FIELD_NOT_CHANGEABLE', '_destroy'],
    ]);
  });

  it('rejects the spec for a form with a visible field whose name looks like a secret (its value cannot be read)', () => {
    const candidate = editCandidate('7', { fields: [...EDIT_FIELDS, sampleField('state', 'text')] });
    const errors = errorsOf(validate(
      updateDraft({ candidateIdentityDigest: candidate.identityDigest }, { keepFieldNames: [...UPDATE_SPEC.keepFieldNames, 'state'] }),
      candidate,
    ));
    expect(errors.map(({ code, fieldName }) => [code, fieldName])).toEqual([['SCENARIO_UPDATE_FORM_HAS_SECRET_LIKE_FIELD', 'state']]);
    // hidden の秘密に見える名前の欄（CSRF のトークンなど）は、値を読まないので止めない。
    const hiddenToken = editCandidate('7', { fields: [...EDIT_FIELDS, sampleField('access_token', 'hidden', { hasValue: true })] });
    expect(codesOf(validate(updateDraft({ candidateIdentityDigest: hiddenToken.identityDigest }), hiddenToken))).toEqual([]);
  });

  // T31e fix round 1（Task 31 の設計書 3 章の「削除にあたる変更の遮断」）: 状態の語に当たり、秘密に見える名前でもある、値を送る見えない欄は、値を
  // 読めず照らせないので、その画面の UPDATE の指定を受けない（ワーカーの欄の役割の `SECRET_LIKE_STATE_FIELD` と同じ判定 `isSecretLikeStateField`）。
  it.each([
    ['a hidden field', sampleField('state', 'hidden', { hasValue: true })],
    ['an invisible text field', sampleField('state', 'text', { hidden: true })],
    ['a readonly text field', sampleField('state', 'text', { readonly: true })],
  ] as const)('rejects the spec for a form with %s whose name is a state word and looks like a secret', (_name, stateField) => {
    const candidate = editCandidate('7', { fields: [...EDIT_FIELDS, stateField] });
    const errors = errorsOf(validate(updateDraft({ candidateIdentityDigest: candidate.identityDigest }), candidate));
    // readonly の欄は見える欄でもあるので、秘密に見える名前の見える欄の誤りも出る。
    expect(errors.map(({ code, fieldName }) => [code, fieldName])).toContainEqual(['SCENARIO_UPDATE_FORM_HAS_SECRET_LIKE_STATE_FIELD', 'state']);
    expect(errors.every(({ fieldName }) => fieldName === 'state')).toBe(true);
  });

  it.each([
    ['a disabled hidden state field (its value is not sent)', sampleField('state', 'hidden', { hasValue: true, disabled: true })],
    ['a hidden state field whose name does not look like a secret', sampleField('record_status', 'hidden', { hasValue: true })],
    ['a hidden field whose name looks like a secret but is not a state word', sampleField('access_token', 'hidden', { hasValue: true })],
  ] as const)('accepts the spec for a form with %s', (_name, otherField) => {
    const candidate = editCandidate('7', { fields: [...EDIT_FIELDS, otherField] });
    expect(codesOf(validate(updateDraft({ candidateIdentityDigest: candidate.identityDigest }), candidate))).toEqual([]);
  });

  it('shares one judgement with the worker roles of an UPDATE form (isSecretLikeStateField)', () => {
    const base = { name: 'state', type: 'hidden', hidden: false, readonly: false, disabled: false } as const;
    expect(isSecretLikeStateField(base)).toBe(true);
    expect(isSecretLikeStateField({ ...base, disabled: true })).toBe(false);
    expect(isSecretLikeStateField({ ...base, type: 'text' })).toBe(false);
    expect(isSecretLikeStateField({ ...base, type: 'text', readonly: true })).toBe(true);
    expect(isSecretLikeStateField({ ...base, type: 'text', hidden: true })).toBe(true);
    expect(isSecretLikeStateField({ ...base, name: 'record_status' })).toBe(false);
    expect(isSecretLikeStateField({ ...base, name: '' })).toBe(false);
  });

  it.each([
    ['an id that is not a scenario', 'scenario-missing', 'SCENARIO_UPDATE_TARGET_NOT_FOUND'],
    ['a scenario of another profile', 'scenario-foreign', 'SCENARIO_UPDATE_TARGET_NOT_FOUND'],
    ['an UPDATE scenario', 'scenario-update-other', 'SCENARIO_UPDATE_TARGET_NOT_CREATE'],
    ['the scenario itself', 'scenario-update', 'SCENARIO_UPDATE_TARGET_NOT_CREATE'],
  ])('rejects a target that is not a CREATE scenario of the profile (%s)', (_label, targetCreateScenarioId, code) => {
    const contextWithSelf: ScenarioDraftContext = {
      scenarioId: 'scenario-update',
      scenarios: [...SCENARIO_FACTS, { scenarioId: 'scenario-update', profileId: PROFILE_ID, kind: 'CREATE' }],
    };
    expect(codesOf(validate(updateDraft({}, { targetCreateScenarioId }), EDIT_CANDIDATE, contextWithSelf))).toEqual([code]);
  });

  it('does not find any target without the context (the default is no scenario)', () => {
    expect(codesOf(validateScenarioDraft(updateDraft(), EDIT_CANDIDATE, []))).toEqual(['SCENARIO_UPDATE_TARGET_NOT_FOUND']);
  });

  it('accepts the method overrides PUT and none, and rejects DELETE as before', () => {
    for (const methodOverride of ['PUT', null] as const) {
      const candidate = editCandidate('7', { methodOverride });
      const result = validate(updateDraft({ candidateIdentityDigest: candidate.identityDigest }), candidate);
      // 上書きのない POST の form は、分類が UPDATE でないことがある（分類の owner の判定）。UPDATE に分類されたときだけ受ける。
      if (candidate.classification === 'UPDATE') {
        expect(codesOf(result), String(methodOverride)).toEqual([]);
      }
    }
    const deleting = editCandidate('7', { methodOverride: 'DELETE' });
    expect(codesOf(validate(updateDraft({ candidateIdentityDigest: deleting.identityDigest }), deleting))).not.toEqual([]);
  });
});

// T31R-fix-1 の I-2（Task 31 の設計書 11 章の T31R の行）: path の型の `{id}` の位置を、参照した CREATE のシナリオ（台帳）の登録の ID の取り方に
// 結ぶ。取り方が `URL_PATH_PATTERN` なら、UPDATE の送信先の型の `{id}` の前の区切りが、その型の `{id}` の前の区切りと同じ。`ELEMENT` なら、送信先の
// 型の `{id}` が最後の区切り。台帳の取り方が未指定（null か事実にない）なら確かめない（照合まで済んだ登録がないので、発行が止まる）。
describe('the record id segment of the UPDATE templates bound to the ledger (T31R-fix-1 I-2)', () => {
  const URL_LEDGER = { source: 'URL_PATH_PATTERN', pathPattern: '/members/{id}' } as const;
  const ELEMENT_LEDGER = { source: 'ELEMENT', selector: '#record-id' } as const;
  /** 台帳の取り方つきの文脈。 */
  const contextWith = (recordId: Exclude<ScenarioKindFact['recordId'], undefined>): ScenarioDraftContext => Object.freeze({
    scenarioId: 'scenario-update',
    scenarios: SCENARIO_FACTS.map((fact) => (fact.scenarioId === 'scenario-create' ? { ...fact, recordId } : fact)),
  });

  it.each<readonly [string, string, ScenarioKindFact['recordId'] | undefined, boolean]>([
    ['the same segment before {id} as the ledger pattern', '/members/{id}', URL_LEDGER, true],
    ['the same segment before {id} under a longer path', '/admin/members/{id}', URL_LEDGER, true],
    ['another segment before {id}', '/t/{id}/members/7', URL_LEDGER, false],
    ['{id} at the start (no segment before it)', '/{id}/members', URL_LEDGER, false],
    ['{id} as the last segment for an element', '/members/{id}', ELEMENT_LEDGER, true],
    ['{id} before another segment for an element', '/members/{id}/update', ELEMENT_LEDGER, false],
    ['no record id spec of the ledger (not checked)', '/t/{id}/members/7', null, true],
    ['no fact of the record id spec (not checked)', '/t/{id}/members/7', undefined, true],
    // T31R2-fix-1 の I-1: `{id}` の後ろの並びは台帳の型と同じ、前の並びは台帳の型の前の並び全体と後ろから一致する（T31R2 の例を含む）。
    ['more segments after {id} than the ledger pattern (T31R2)', '/members/{id}/notes/5', URL_LEDGER, false],
    ['other segments before {id} than the ledger pattern (T31R2)', '/b/members/{id}', { source: 'URL_PATH_PATTERN', pathPattern: '/a/members/{id}' }, false],
    ['the whole segments before {id} of the ledger pattern under a longer path', '/x/a/members/{id}',
      { source: 'URL_PATH_PATTERN', pathPattern: '/a/members/{id}' }, true],
    ['fewer segments before {id} than the ledger pattern', '/members/{id}', { source: 'URL_PATH_PATTERN', pathPattern: '/a/members/{id}' }, false],
    ['the same segments after {id} as the ledger pattern', '/members/{id}/show', { source: 'URL_PATH_PATTERN', pathPattern: '/members/{id}/show' }, true],
    ['other segments after {id} than the ledger pattern', '/members/{id}', { source: 'URL_PATH_PATTERN', pathPattern: '/members/{id}/show' }, false],
  ])('binds the action template with %s', (_label, actionPathTemplate, recordId, bound) => {
    expect(isUpdatePathBoundToLedger(actionPathTemplate, recordId ?? null)).toBe(bound);
  });

  it('accepts the templates bound to the ledger (URL path pattern and element)', () => {
    expect(codesOf(validate(updateDraft(), EDIT_CANDIDATE, contextWith(URL_LEDGER)))).toEqual([]);
    expect(codesOf(validate(updateDraft(), EDIT_CANDIDATE, contextWith(ELEMENT_LEDGER)))).toEqual([]);
    expect(codesOf(validate(updateDraft(), EDIT_CANDIDATE, contextWith(null)))).toEqual([]);
  });

  it('rejects the segment acme of /t/acme/members/7/edit (the example of the review) for both ways to take the record id', () => {
    const tenant = editCandidate('7', { page: { origin: SAMPLE_ORIGIN, path: '/t/acme/members/7/edit' }, action: sampleAction('/t/acme/members/7') });
    const acme = { formPathTemplate: '/t/{id}/members/7/edit', actionPathTemplate: '/t/{id}/members/7' };
    const draft = updateDraft({ candidateIdentityDigest: tenant.identityDigest }, acme);
    // 型そのものは候補の path に同じ値（`acme`）で戻るので、台帳に結ばなければ受けてしまう（レビューの指摘）。
    expect(codesOf(validate(draft, tenant, contextWith(null)))).toEqual([]);
    for (const ledger of [{ source: 'URL_PATH_PATTERN', pathPattern: '/t/acme/members/{id}' } as const, ELEMENT_LEDGER]) {
      expect(codesOf(validate(draft, tenant, contextWith(ledger))), ledger.source).toEqual(['SCENARIO_UPDATE_PATH_NOT_BOUND_TO_LEDGER_ID']);
    }
    // ID の区切り（`7`）を選んだ型は、どちらの取り方にも結び付く。
    const record = updateDraft({ candidateIdentityDigest: tenant.identityDigest },
      { formPathTemplate: '/t/acme/members/{id}/edit', actionPathTemplate: '/t/acme/members/{id}' });
    for (const ledger of [{ source: 'URL_PATH_PATTERN', pathPattern: '/t/acme/members/{id}' } as const, ELEMENT_LEDGER]) {
      expect(codesOf(validate(record, tenant, contextWith(ledger))), ledger.source).toEqual([]);
    }
  });

  // T31R2-fix-1 の I-1: T31R2 の例（`{id}` の後ろに区切りが続く送信先）を、下書きの確かめでも拒む。
  it('rejects /members/{id}/notes/5 for the ledger /members/{id} (the example of the second review)', () => {
    const notes = editCandidate('7', { page: { origin: SAMPLE_ORIGIN, path: '/members/7/notes/5/edit' }, action: sampleAction('/members/7/notes/5') });
    const draft = updateDraft({ candidateIdentityDigest: notes.identityDigest },
      { formPathTemplate: '/members/{id}/notes/5/edit', actionPathTemplate: '/members/{id}/notes/5' });
    expect(codesOf(validate(draft, notes, contextWith(null)))).toEqual([]);
    expect(codesOf(validate(draft, notes, contextWith(URL_LEDGER)))).toEqual(['SCENARIO_UPDATE_PATH_NOT_BOUND_TO_LEDGER_ID']);
    expect(codesOf(validate(draft, notes, contextWith(ELEMENT_LEDGER)))).toEqual(['SCENARIO_UPDATE_PATH_NOT_BOUND_TO_LEDGER_ID']);
  });
});
