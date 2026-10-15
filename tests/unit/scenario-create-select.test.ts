// T30f fix round 1（DEF-098。Task 30 の設計書 3 章の「送る中身の照合」）: CREATE のシナリオの下書きの確かめ（`scenario-policy.ts`）。見えていて
// 編集できる、既定の値が分からない欄（select-one・select-multiple・range・color）を送る欄に選ばないと、ブラウザが既定の値で送り、照合の期待を作れない
// （書き込みの入力の部品は送らない）。下書きの段で受けない（`SCENARIO_CREATE_DEFAULT_VALUE_FIELD_NOT_SENT`。欄ごと）。
// - T30f fix round 2: 入力の部品と同じ型の一覧（`src/discovery/candidate-contracts.ts` の `DEFAULT_VALUE_FIELD_TYPES`）を使う。range・color も受けない。
//   どの型でも、入力の部品が送らない（`SPEC_INVALID`）ことと、下書きの確かめが受けないことが一致する（片方だけ変えると落ちる）。
// - 送る欄に選んだ欄、disabled・見えない欄は対象の外。
// - UPDATE は、欄の役割（変える欄か保つ欄）で必ず扱うので対象の外。
// 例の値は、匿名の値（`127.0.0.1`）だけを使う。
import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { inspectWriteForm } from '../../src/browser/write-form-submitter.js';
import { SCENARIO_DRAFT_REJECTION_REASONS, validateScenarioDraft, type ScenarioDraftValidationResult } from '../../src/control/approval/scenario-policy.js';
import {
  CANDIDATE_FIELD_TYPES,
  DEFAULT_VALUE_FIELD_TYPES,
  type CandidateField,
  type CandidateFieldType,
  type DiscoveryCandidate,
} from '../../src/discovery/candidate-contracts.js';
import { CREATE_CANDIDATE, READ_CHECK_FACTS, candidateOf, sampleDraft } from './approval-samples.js';
import { SAMPLE_ORIGIN, sampleAction, sampleField, sampleForm } from './discovery-candidate-samples.js';

const REASON = 'SCENARIO_CREATE_DEFAULT_VALUE_FIELD_NOT_SENT';

const codesOf = (result: ScenarioDraftValidationResult): readonly (readonly [string, string | null])[] =>
  (result.ok ? [] : result.errors.map(({ code, fieldName }) => [code, fieldName] as const));

const createCandidate = (fields: readonly CandidateField[]): DiscoveryCandidate => candidateOf(sampleForm({
  page: { origin: SAMPLE_ORIGIN, path: '/orders/new' },
  action: sampleAction('/orders'),
  submitterText: '登録',
  fields,
}));

const validateCreate = (candidate: DiscoveryCandidate, fieldNames: readonly string[]): ScenarioDraftValidationResult =>
  validateScenarioDraft(sampleDraft({ candidateIdentityDigest: candidate.identityDigest, fieldNames, readChecks: [] }), candidate, READ_CHECK_FACTS);

/** 見えていて編集できる、名前 `extra` の型 `type` の欄を、送る欄に選ばない CREATE の候補（名前だけを送る）。 */
const withUnchosen = (type: CandidateFieldType): DiscoveryCandidate => createCandidate([
  sampleField('name', 'text', { required: true }),
  sampleField('extra', type, ['select-one', 'select-multiple', 'checkbox', 'radio'].includes(type) ? { options: ['a', 'b'] } : {}),
]);

describe('DEF-098: a CREATE scenario must send the visible, editable fields whose default value is unknown', () => {
  it('has the reason in the closed list', () => {
    expect(SCENARIO_DRAFT_REJECTION_REASONS).toContain(REASON);
  });

  it('closes the list of the types whose default value is unknown', () => {
    expect(DEFAULT_VALUE_FIELD_TYPES).toEqual(['select-one', 'select-multiple', 'range', 'color']);
  });

  it('rejects each visible, editable select, range or color that is not a field to send, and accepts the draft that sends them', () => {
    const candidate = createCandidate([
      sampleField('name', 'text', { required: true }),
      sampleField('plan', 'select-one', { options: ['a', 'b'] }),
      sampleField('tags', 'select-multiple', { options: ['x', 'y'] }),
      sampleField('level', 'range'),
      sampleField('tint', 'color'),
      sampleField('memo', 'textarea'),
      sampleField('agree', 'checkbox'),
    ]);
    expect(candidate.classification).toBe('CREATE');
    expect(codesOf(validateCreate(candidate, ['name']))).toEqual([
      [REASON, 'plan'],
      [REASON, 'tags'],
      [REASON, 'level'],
      [REASON, 'tint'],
    ]);
    expect(codesOf(validateCreate(candidate, ['name', 'plan', 'level']))).toEqual([[REASON, 'tags'], [REASON, 'tint']]);
    // 任意の text・textarea・checkbox は、選ばなくてよい（照合が空・未チェックで照らす）。
    expect(codesOf(validateCreate(candidate, ['name', 'plan', 'tags', 'level', 'tint']))).toEqual([]);
  });

  it('does not need a disabled or invisible field whose default value is unknown', () => {
    const candidate = createCandidate([
      sampleField('name', 'text', { required: true }),
      sampleField('plan', 'select-one', { options: ['a'], disabled: true }),
      sampleField('region', 'select-one', { options: ['a'], hidden: true }),
      sampleField('level', 'range', { disabled: true }),
      sampleField('tint', 'color', { hidden: true }),
    ]);
    expect(codesOf(validateCreate(candidate, ['name']))).toEqual([]);
  });

  it('applies to the shared CREATE sample, whose select is a field to send in the sample draft', () => {
    expect(codesOf(validateScenarioDraft(sampleDraft({ fieldNames: ['name', 'email'] }), CREATE_CANDIDATE, READ_CHECK_FACTS)))
      .toEqual([[REASON, 'plan']]);
  });

  // T30f fix round 2: 入力の部品が送らない（`SPEC_INVALID`）型と、下書きの確かめが受けない型が、どの型でも一致する。
  it.each(CANDIDATE_FIELD_TYPES.filter((type) => type !== 'password' && type !== 'file' && type !== 'hidden'))(
    'agrees with the write form submitter for an unchosen visible %s field',
    async (type) => {
      const candidate = withUnchosen(type);
      const draftRejected = codesOf(validateCreate(candidate, ['name'])).some(([code]) => code === REASON);
      const inspection = await inspectWriteForm({} as Page, {
        endpoint: { origin: SAMPLE_ORIGIN, path: '/orders' },
        enctype: 'application/x-www-form-urlencoded',
        candidateFields: candidate.fields,
        submittedFieldNames: ['name'],
        methodOverride: null,
      });
      const submitterRejected = !inspection.ok && inspection.reason === 'SPEC_INVALID';
      const expected = (DEFAULT_VALUE_FIELD_TYPES as readonly string[]).includes(type);
      expect([draftRejected, submitterRejected]).toEqual([expected, expected]);
    },
  );
});
