// T31R2-fix-1 の項目 3（C-1 の下書きの確かめ。DEF-108 の残り）: 値を読めず照らせない、秘密に見える名前の欄（`src/discovery/read-check-contracts.ts` の
// `isUnreadableSecretField`。hidden の型・見えない欄・readonly のどれかで、ページが作る値の名前（CSRF のトークンなど。名前だけを照らす）でない、
// 秘密に見える名前の欄）がある画面は、登録も更新も、下書きの確かめで受けない（`SCENARIO_FORM_HAS_UNREADABLE_SECRET_FIELD`。欄ごと）。
// - ページが作る値の名前（`authenticity_token`・`auth_token` など）、disabled の欄、見える欄（見える欄は送る欄の確かめと UPDATE の確かめが扱う）は
//   当たらない。
// - 更新で、状態の語に当たり秘密に見える名前でもある見えない欄は、今の理由（`SCENARIO_UPDATE_FORM_HAS_SECRET_LIKE_STATE_FIELD`）だけを出す（重ねない）。
// 例の値は、匿名の値だけを使う。
import { describe, expect, it } from 'vitest';
import type { ScenarioKindFact } from '../../src/control/approval/scenario-contracts.js';
import {
  SCENARIO_DRAFT_REJECTION_REASONS,
  validateScenarioDraft,
  type ScenarioDraftContext,
  type ScenarioDraftValidationResult,
} from '../../src/control/approval/scenario-policy.js';
import type { CandidateField, DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { isUnreadableSecretField } from '../../src/discovery/read-check-contracts.js';
import { PROFILE_ID, READ_CHECK_FACTS, candidateOf, sampleDraft } from './approval-samples.js';
import { SAMPLE_ORIGIN, sampleAction, sampleField, sampleForm } from './discovery-candidate-samples.js';

const REASON = 'SCENARIO_FORM_HAS_UNREADABLE_SECRET_FIELD';

const errorsOf = (result: ScenarioDraftValidationResult): readonly (readonly [string, string | null])[] =>
  (result.ok ? [] : result.errors.map(({ code, fieldName }) => [code, fieldName] as const));

/** 登録の画面の候補（`name` を送る欄にする。足す欄を受ける）。 */
const createCandidate = (extra: readonly CandidateField[]): DiscoveryCandidate => candidateOf(sampleForm({
  page: { origin: SAMPLE_ORIGIN, path: '/members/new' },
  action: sampleAction('/members'),
  submitterText: '登録',
  fields: [sampleField('name', 'text', { required: true }), ...extra],
}));

/** 更新の画面の候補（PATCH。`name` を変える欄にする）。 */
const updateCandidate = (extra: readonly CandidateField[]): DiscoveryCandidate => candidateOf(sampleForm({
  page: { origin: SAMPLE_ORIGIN, path: '/members/7/edit' },
  action: sampleAction('/members/7'),
  methodOverride: 'PATCH',
  submitterText: '更新',
  fields: [sampleField('name', 'text', { required: true }), sampleField('_method', 'hidden', { hasValue: true }), ...extra],
}));

const CONTEXT: ScenarioDraftContext = Object.freeze({
  scenarioId: 'scenario-update',
  scenarios: Object.freeze([{ scenarioId: 'scenario-create', profileId: PROFILE_ID, kind: 'CREATE' } satisfies ScenarioKindFact]),
});

const validateCreate = (candidate: DiscoveryCandidate) => validateScenarioDraft(
  sampleDraft({ candidateIdentityDigest: candidate.identityDigest, fieldNames: ['name'], readChecks: [] }), candidate, READ_CHECK_FACTS,
);

const validateUpdate = (candidate: DiscoveryCandidate) => validateScenarioDraft(sampleDraft({
  candidateIdentityDigest: candidate.identityDigest,
  fieldNames: ['name'],
  readChecks: [],
  update: { targetCreateScenarioId: 'scenario-create', formPathTemplate: '/members/{id}/edit', actionPathTemplate: '/members/{id}', keepFieldNames: [] },
}), candidate, READ_CHECK_FACTS, CONTEXT);

/** 当たる欄（hidden の型・見えない欄・readonly の、秘密に見える名前）。 */
const UNREADABLE_FIELDS: readonly CandidateField[] = [
  sampleField('ticket', 'hidden', { hasValue: true }),
  sampleField('code', 'text', { hidden: true }),
  sampleField('key', 'text', { readonly: true }),
];

/** 当たらない欄（ページが作る値の名前、disabled、見える欄でない秘密でない名前）。 */
const READABLE_FIELDS: readonly CandidateField[] = [
  sampleField('authenticity_token', 'hidden', { hasValue: true }),
  sampleField('auth_token', 'hidden', { hasValue: true }),
  sampleField('access_token', 'hidden', { hasValue: true }),
  sampleField('code', 'hidden', { disabled: true }),
  sampleField('lock_version', 'hidden', { hasValue: true }),
];

describe('T31R2-fix-1 item 3: a form with a secret-looking field whose value cannot be read', () => {
  it('adds the reason to the closed list, starting with SCENARIO_', () => {
    expect(SCENARIO_DRAFT_REJECTION_REASONS).toContain(REASON);
  });

  it('uses the one judgement of the field owner (the examples hit, the page-issued tokens and disabled fields do not)', () => {
    expect(UNREADABLE_FIELDS.map(isUnreadableSecretField)).toEqual([true, true, true]);
    expect(READABLE_FIELDS.map(isUnreadableSecretField)).toEqual([false, false, false, false, false]);
  });

  it.each(UNREADABLE_FIELDS.map((field) => [field.name, field] as const))('rejects a CREATE form with the field %s, by field', (name, field) => {
    expect(errorsOf(validateCreate(createCandidate([field])))).toEqual([[REASON, name]]);
  });

  it.each(UNREADABLE_FIELDS.filter((field) => field.hidden).map((field) => [field.name, field] as const))(
    'rejects an UPDATE form with the invisible field %s, by field',
    (name, field) => {
      expect(errorsOf(validateUpdate(updateCandidate([field])))).toEqual([[REASON, name]]);
    },
  );

  it('keeps the reason of the visible secret-looking field for a readonly field of an UPDATE form (not two reasons)', () => {
    expect(errorsOf(validateUpdate(updateCandidate([sampleField('key', 'text', { readonly: true })]))))
      .toEqual([['SCENARIO_UPDATE_FORM_HAS_SECRET_LIKE_FIELD', 'key']]);
  });

  it('accepts the forms with only the fields the write can read or check by name', () => {
    expect(errorsOf(validateCreate(createCandidate(READABLE_FIELDS)))).toEqual([]);
    expect(errorsOf(validateUpdate(updateCandidate(READABLE_FIELDS)))).toEqual([]);
  });

  it('keeps one reason for a secret-looking state field of an UPDATE form', () => {
    const state = sampleField('state', 'hidden', { hasValue: true });
    expect(errorsOf(validateUpdate(updateCandidate([state])))).toEqual([['SCENARIO_UPDATE_FORM_HAS_SECRET_LIKE_STATE_FIELD', 'state']]);
    // 登録は、同じ欄を読めない欄として拒む。
    expect(errorsOf(validateCreate(createCandidate([state])))).toEqual([[REASON, 'state']]);
  });
});
