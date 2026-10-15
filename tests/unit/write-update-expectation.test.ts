// T31g-1（Task 31 の設計書 3 章の「欄の役割」「保つ欄の期待は前の値」「削除にあたる変更の遮断」「同じ名前の hidden と checkbox の組」）: UPDATE の
// 送る中身の照合の期待の作り手（`src/browser/write-form-submitter.ts` の `updatePayloadFieldsOf`。純粋）の表。作った期待が照合の owner
// （`checkWritePayload`）の指定の確かめに通ることも確かめる。
import { describe, expect, it } from 'vitest';
import {
  updatePayloadFieldsOf,
  type UpdateFormValues,
  type WriteFormFieldSpec,
  type WriteUpdateFormSpec,
} from '../../src/browser/write-form-submitter.js';
import { checkWritePayload, type WritePayloadExpectation } from '../../src/safety/write-payload-policy.js';

const ORIGIN = 'http://127.0.0.1:8080';
const PATH = '/items/12';

const field = (name: string, type: WriteFormFieldSpec['type'], flags: Partial<Pick<WriteFormFieldSpec, 'readonly' | 'hidden' | 'disabled'>> = {}): WriteFormFieldSpec =>
  ({ name, type, readonly: false, hidden: false, disabled: false, ...flags });
const hiddenField = (name: string): WriteFormFieldSpec => field(name, 'hidden', { hidden: true });

/** 更新の画面の欄（DOM の順）。 */
const FIELDS: readonly WriteFormFieldSpec[] = [
  hiddenField('_method'),
  hiddenField('authenticity_token'),
  field('customer_name', 'text'),
  field('memo', 'textarea'),
  field('plan', 'select-one'),
  field('contact', 'radio'),
  field('contact', 'radio'),
  field('newsletter', 'checkbox'),
  field('notify', 'checkbox'),
  field('ref_no', 'text', { readonly: true }),
  field('attachment', 'file'),
  field('archived_at', 'text', { disabled: true }),
  hiddenField('active'),
  hiddenField('published'),
  field('published', 'checkbox'),
  hiddenField('lock_version'),
];

const KEPT = ['memo', 'plan', 'contact', 'newsletter', 'notify', 'published'];

const specOf = (overrides: Partial<WriteUpdateFormSpec> = {}): WriteUpdateFormSpec => ({
  endpoint: { origin: ORIGIN, path: PATH },
  enctype: 'application/x-www-form-urlencoded',
  candidateFields: FIELDS,
  methodOverride: 'PATCH',
  changedFieldNames: ['customer_name'],
  keptFieldNames: KEPT,
  ...overrides,
});

const PRIOR: UpdateFormValues = {
  fields: { customer_name: '山田 太郎', memo: '一行目\n二行目', plan: 'premium', contact: 'mail', newsletter: 'yes', notify: null, published: '1' },
  stateHiddenValues: { active: '1' },
  pairOffValues: { published: '0' },
  // T31R-fix-1（C-1）: 秘密に見えない readonly・hidden の欄の前の値（値を照らす。更新の後の照合では比べない）。
  passthroughValues: { ref_no: 'R-1', lock_version: '7' },
};

const NEW_VALUES = { customer_name: '佐藤 花子' };

describe('T31g-1: the expectation maker of an update (updatePayloadFieldsOf)', () => {
  it('puts the new value of a changed field, the prior values of the kept fields, the state hidden and the pair into the expectation', () => {
    const made = updatePayloadFieldsOf(specOf(), PRIOR, NEW_VALUES);
    expect(made).toEqual({
      ok: true,
      fields: {
        submittedFields: [
          { name: 'customer_name', value: '佐藤 花子' },
          { name: 'memo', value: '一行目\n二行目' },
          { name: 'plan', value: 'premium' },
          { name: 'contact', value: 'mail' },
          { name: 'newsletter', value: 'yes' },
        ],
        // T31R-fix-1（C-1）: 名前だけを照らすのは、秘密に見える名前の欄（CSRF のトークン）だけ。
        passthroughFieldNames: ['authenticity_token'],
        emptyFileFieldNames: ['attachment'],
        methodOverride: 'PATCH',
        // T31R2-fix-1（C-1）: disabled の欄（`archived_at`）は「送られない」。
        absentFieldNames: ['notify', 'archived_at'],
        checkedPassthroughFields: [{ name: 'active', value: '1' }, { name: 'ref_no', value: 'R-1' }, { name: 'lock_version', value: '7' }],
        checkboxPairs: [{ name: 'published', offValue: '0', checkedValue: '1' }],
      },
    });
    // 照合の owner の指定の確かめに通る（`EXPECTATION_INVALID` にならない。要求の形が違うので、その理由で止まる）。
    if (made.ok) {
      const expectation: WritePayloadExpectation = { request: { origin: ORIGIN, path: PATH, enctype: 'application/x-www-form-urlencoded' }, ...made.fields };
      expect(checkWritePayload(expectation, {
        method: 'GET', url: `${ORIGIN}${PATH}`, isMainFrameNavigation: true, contentType: null, hasPostData: false, postDataEntries: null,
        documentCharset: 'UTF-8',
      })).toBe('NOT_POST');
    }
  });

  it.each([
    ['a kept pair unchecked before', { ...PRIOR, fields: { ...PRIOR.fields, published: null } }, NEW_VALUES,
      { checkboxPairs: [{ name: 'published', offValue: '0', checkedValue: null }] }],
    ['a kept radio group with no choice and a kept checkbox checked before', { ...PRIOR, fields: { ...PRIOR.fields, contact: null, notify: 'on' } }, NEW_VALUES,
      { absentFieldNames: ['contact', 'archived_at'] }],
    // T31R2-fix-1（C-1）: disabled の欄（`archived_at`）は「送られない」（保つ欄の後ろ）。
    ['a kept select with no option', { ...PRIOR, fields: { ...PRIOR.fields, plan: null } }, NEW_VALUES, { absentFieldNames: ['plan', 'notify', 'archived_at'] }],
  ] as const)('places %s', (_name, prior, values, expected) => {
    const made = updatePayloadFieldsOf(specOf(), prior, values);
    expect(made.ok).toBe(true);
    expect(made.ok ? made.fields : null).toMatchObject(expected);
  });

  it('places a changed checkbox to uncheck in the absent fields, and a changed pair with the new checked value', () => {
    const spec = specOf({ changedFieldNames: ['customer_name', 'newsletter'], keptFieldNames: ['memo', 'plan', 'contact', 'notify', 'published'] });
    expect(updatePayloadFieldsOf(spec, PRIOR, { customer_name: 'x', newsletter: null })).toMatchObject({
      ok: true, fields: { absentFieldNames: ['newsletter', 'notify', 'archived_at'] },
    });
    // 組を変える欄にする（状態の語の名前 `published` は変える欄にできない）ので、状態の語でない組の画面で確かめる。
    const pairFields = [hiddenField('agree'), field('agree', 'checkbox'), field('customer_name', 'text')];
    expect(updatePayloadFieldsOf(
      specOf({ candidateFields: pairFields, changedFieldNames: ['agree'], keptFieldNames: ['customer_name'], methodOverride: null }),
      { fields: { agree: null, customer_name: '山田' }, stateHiddenValues: {}, pairOffValues: { agree: '0' }, passthroughValues: {} },
      { agree: '1' },
    )).toEqual({
      ok: true,
      fields: {
        submittedFields: [{ name: 'customer_name', value: '山田' }],
        passthroughFieldNames: [],
        emptyFileFieldNames: [],
        methodOverride: null,
        absentFieldNames: [],
        checkedPassthroughFields: [],
        checkboxPairs: [{ name: 'agree', offValue: '0', checkedValue: '1' }],
      },
    });
  });

  it.each<[string, WriteUpdateFormSpec, UpdateFormValues, Readonly<Record<string, string | null>>]>([
    ['no changed field', specOf({ changedFieldNames: [] }), PRIOR, {}],
    ['a field both changed and kept', specOf({ keptFieldNames: [...KEPT, 'customer_name'] }), PRIOR, NEW_VALUES],
    ['a visible, editable field without a role', specOf({ keptFieldNames: KEPT.filter((name) => name !== 'plan') }), PRIOR, NEW_VALUES],
    ['a changed state field', specOf({ changedFieldNames: ['customer_name', 'published'], keptFieldNames: KEPT.filter((name) => name !== 'published') }),
      PRIOR, { ...NEW_VALUES, published: null }],
    ['a role for a hidden field', specOf({ keptFieldNames: [...KEPT, 'lock_version'] }), PRIOR, NEW_VALUES],
    ['a role for a readonly field', specOf({ keptFieldNames: [...KEPT, 'ref_no'] }), PRIOR, NEW_VALUES],
    ['a role for _method', specOf({ keptFieldNames: [...KEPT, '_method'] }), PRIOR, NEW_VALUES],
    ['a visible field with a secret-like name', specOf({ candidateFields: [...FIELDS, field('access_token', 'text')], keptFieldNames: [...KEPT, 'access_token'] }),
      { ...PRIOR, fields: { ...PRIOR.fields, access_token: 'x' } }, NEW_VALUES],
    ['a text field and a hidden field of the same name (no expectation)', specOf({ candidateFields: [...FIELDS, hiddenField('memo')] }), PRIOR, NEW_VALUES],
    ['two state hidden fields of the same name', specOf({ candidateFields: [...FIELDS, hiddenField('active')] }), PRIOR, NEW_VALUES],
    ['a prior value missing for a kept field', specOf(), { ...PRIOR, fields: { customer_name: 'a', memo: 'b' } }, NEW_VALUES],
    ['a prior value missing for the state hidden', specOf(), { ...PRIOR, stateHiddenValues: {} }, NEW_VALUES],
    // T31R-fix-1（C-1）: 値を照らす hidden・readonly の前の値がない、同じ名前の値を照らす hidden が 2 つ。
    ['a prior value missing for a checked hidden', specOf(), { ...PRIOR, passthroughValues: { ref_no: 'R-1' } }, NEW_VALUES],
    ['two checked hidden fields of the same name', specOf({ candidateFields: [...FIELDS, hiddenField('lock_version')] }), PRIOR, NEW_VALUES],
    // T31R-fix-1（I-1）: 削除の語に当たる名前の欄（`fieldNameHasRemovalWord`）は、変える欄にできない（状態の欄と同じ止め方）。
    ['a changed field whose name has a removal word', specOf({ candidateFields: [...FIELDS, field('withdrawn', 'text')], changedFieldNames: ['customer_name', 'withdrawn'] }),
      { ...PRIOR, fields: { ...PRIOR.fields, withdrawn: '' } }, { ...NEW_VALUES, withdrawn: 'yes' }],
    ['a prior value missing for the hidden of the pair', specOf(), { ...PRIOR, pairOffValues: {} }, NEW_VALUES],
    ['a new value missing', specOf(), PRIOR, {}],
    ['a new value for a kept field', specOf(), PRIOR, { ...NEW_VALUES, memo: 'x' }],
    ['a null new value for a text field', specOf(), PRIOR, { customer_name: null }],
    ['a null prior value for a kept text field', specOf(), { ...PRIOR, fields: { ...PRIOR.fields, memo: null } }, NEW_VALUES],
    ['an enctype outside the closed list', specOf({ enctype: 'text/plain' as never }), PRIOR, NEW_VALUES],
    ['a DELETE method override', specOf({ methodOverride: 'DELETE' as never }), PRIOR, NEW_VALUES],
  ])('rejects %s (SPEC_INVALID)', (_name, spec, prior, values) => {
    expect(updatePayloadFieldsOf(spec, prior, values)).toEqual({ ok: false, reason: 'SPEC_INVALID' });
  });

  // T31g-1 fix round 1: 状態の語に当たり、秘密に見える名前でもある欄（`state`）は、値を読めない（秘密に見える名前の値は読まない）ので照らせない。
  // 名前だけを照らすと、ページの JS が値を変えても止まらない（削除にあたる変更の穴）ので、その欄がある更新の画面は実行しない。
  it.each<[string, WriteFormFieldSpec]>([
    ['a hidden field', hiddenField('state')],
    ['an invisible text field', field('state', 'text', { hidden: true })],
    ['a readonly text field', field('state', 'text', { readonly: true })],
  ])('rejects a form with %s whose name is a state word and looks like a secret (SECRET_LIKE_STATE_FIELD)', (_name, stateField) => {
    expect(updatePayloadFieldsOf(specOf({ candidateFields: [...FIELDS, stateField] }), PRIOR, NEW_VALUES))
      .toEqual({ ok: false, reason: 'SECRET_LIKE_STATE_FIELD' });
  });
});

// T31R2-fix-1（C-1。DEF-108 の残り）: 値を照らす判定の外だった形（見えない checkbox・select、disabled の欄、秘密に見える名前の一般の名前）。
describe('T31R2-fix-1: the invisible choices, the disabled fields and the secret-like names in the payload expectation of an update', () => {
  const E8_FIELDS: readonly WriteFormFieldSpec[] = [
    ...FIELDS,
    field('member[addresses][0][_destroy]', 'checkbox', { hidden: true }),
    field('owner_id', 'select-one', { hidden: true }),
    field('parent_id', 'hidden', { hidden: true, disabled: true }),
  ];
  const e8Prior = (destroy: string | null): UpdateFormValues => ({
    ...PRIOR, passthroughValues: { ...PRIOR.passthroughValues, 'member[addresses][0][_destroy]': destroy, owner_id: 'o-1' },
  });

  it('expects the prior state of the invisible checkbox and select, and the disabled field not sent', () => {
    expect(updatePayloadFieldsOf(specOf({ candidateFields: E8_FIELDS }), e8Prior(null), NEW_VALUES)).toMatchObject({
      ok: true,
      fields: {
        absentFieldNames: ['notify', 'archived_at', 'parent_id', 'member[addresses][0][_destroy]'],
        checkedPassthroughFields: [
          { name: 'active', value: '1' }, { name: 'ref_no', value: 'R-1' }, { name: 'lock_version', value: '7' }, { name: 'owner_id', value: 'o-1' },
        ],
      },
    });
    expect(updatePayloadFieldsOf(specOf({ candidateFields: E8_FIELDS }), e8Prior('1'), NEW_VALUES)).toMatchObject({
      ok: true,
      fields: { checkedPassthroughFields: expect.arrayContaining([{ name: 'member[addresses][0][_destroy]', value: '1' }]) },
    });
  });

  it.each<[string, readonly WriteFormFieldSpec[], string]>([
    ['a hidden code', [...FIELDS, hiddenField('code')], 'SECRET_LIKE_PASSTHROUGH_FIELD'],
    ['a readonly key', [...FIELDS, field('key', 'text', { readonly: true })], 'SECRET_LIKE_PASSTHROUGH_FIELD'],
    ['an invisible ticket', [...FIELDS, field('ticket', 'text', { hidden: true })], 'SECRET_LIKE_PASSTHROUGH_FIELD'],
    ['an invisible select-multiple', [...FIELDS, field('tags', 'select-multiple', { hidden: true })], 'SPEC_INVALID'],
    ['a disabled field with the name of a kept field', [...FIELDS, field('memo', 'text', { disabled: true })], 'SPEC_INVALID'],
  ])('rejects a form with %s', (_label, fields, reason) => {
    expect(updatePayloadFieldsOf(specOf({ candidateFields: fields }), PRIOR, NEW_VALUES)).toEqual({ ok: false, reason });
  });
});
