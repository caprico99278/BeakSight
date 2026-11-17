// T31g-1（Task 31 の設計書 3 章の「欄の役割」「保つ欄の期待は前の値」「削除にあたる変更の遮断」「同じ名前の hidden と checkbox の組」）: UPDATE の
// 送る中身の照合の期待の作り手（`src/browser/write-form-submitter.ts` の `updatePayloadFieldsOf`。純粋）の表。作った期待が照合の owner
// （`checkWritePayload`）の指定の確かめに通ることも確かめる。
import { describe, expect, it } from 'vitest';
import {
  updateBasePayloadFieldsOf,
  updateDeferredPriorValuesOf,
  updatePayloadFieldsOf,
  type UpdateFormValues,
  type WriteFormFieldSpec,
  type WriteUpdateFormSpec,
} from '../../src/browser/write-form-submitter.js';
import { checkWritePayload, writeExpectationWithPriorValues, type WritePayloadExpectation } from '../../src/safety/write-payload-policy.js';

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

// LU-12a fix round 1（設計者の判断 (b)）: 前の値を後から入れる印の作り手（`updateDeferredPriorValuesOf`。純粋）。鍵の集合は承認の時の欄の役割から作り、
// ページの値から作らない。前の値に null を入れてよい欄（`nullableFieldNames`）は、作り手（`updatePayloadFieldsOf`）と同じ判定（checkbox・radio・select）。
describe('LU-12a fix round 1: the maker of the mark for the prior values supplied later (updateDeferredPriorValuesOf)', () => {
  const E8_FIELDS: readonly WriteFormFieldSpec[] = [
    ...FIELDS,
    field('member[addresses][0][_destroy]', 'checkbox', { hidden: true }),
    field('owner_id', 'select-one', { hidden: true }),
  ];

  it('makes the names from the roles of the fields, and allows null only for the checkbox, radio and select fields', () => {
    const result = updateDeferredPriorValuesOf(specOf({ candidateFields: E8_FIELDS }), NEW_VALUES);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mark.keptFieldNames).toEqual(['memo', 'plan', 'contact', 'newsletter', 'notify']);
    expect(result.mark.keptCheckboxPairNames).toEqual(['published']);
    expect(result.mark.changedCheckboxPairs).toEqual([]);
    expect([...result.mark.checkedPassthroughNames].sort()).toEqual(['active', 'lock_version', 'member[addresses][0][_destroy]', 'owner_id', 'ref_no']);
    expect([...result.mark.nullableFieldNames].sort()).toEqual(['contact', 'member[addresses][0][_destroy]', 'newsletter', 'notify', 'owner_id', 'plan']);
    expect(Object.isFrozen(result.mark)).toBe(true);
  });

  it('agrees with the expectation maker: a null kept text field is refused by both', () => {
    const made = updateDeferredPriorValuesOf(specOf(), NEW_VALUES);
    expect(made.ok && made.mark.nullableFieldNames.includes('memo')).toBe(false);
    expect(updatePayloadFieldsOf(specOf(), { ...PRIOR, fields: { ...PRIOR.fields, memo: null } }, NEW_VALUES)).toEqual({ ok: false, reason: 'SPEC_INVALID' });
    expect(made.ok && made.mark.nullableFieldNames.includes('notify')).toBe(true);
  });

  it('puts a changed pair with the new checked value', () => {
    // 状態の語の名前（`published`）は変える欄にできないので、今の作り手のテストと同じ、状態の語でない組の画面で確かめる。
    const pairFields = [hiddenField('agree'), field('agree', 'checkbox'), field('customer_name', 'text')];
    const spec = specOf({ candidateFields: pairFields, changedFieldNames: ['agree'], keptFieldNames: ['customer_name'], methodOverride: null });
    expect(updateDeferredPriorValuesOf(spec, { agree: null })).toEqual({
      ok: true,
      mark: { keptFieldNames: ['customer_name'], checkedPassthroughNames: [], keptCheckboxPairNames: [], changedCheckboxPairs: [{ name: 'agree', checkedValue: null }], nullableFieldNames: [] },
    });
  });

  it('refuses the values that do not have exactly the changed field names, and an invalid spec', () => {
    expect(updateDeferredPriorValuesOf(specOf(), {})).toEqual({ ok: false, reason: 'SPEC_INVALID' });
    expect(updateDeferredPriorValuesOf(specOf(), { ...NEW_VALUES, memo: 'x' })).toEqual({ ok: false, reason: 'SPEC_INVALID' });
    expect(updateDeferredPriorValuesOf(specOf({ candidateFields: [...FIELDS, hiddenField('code')] }), NEW_VALUES)).toEqual({ ok: false, reason: 'SECRET_LIKE_PASSTHROUGH_FIELD' });
  });
});

// LU-12b（LU-12a の実装者の提案）: 前の値に頼らない基本の期待（`updateBasePayloadFieldsOf`）は、今の作り手と同じ部品から作る。基本の期待に、印と前の値を入れた
// 期待は、今の作り手の期待と同じ欄の集まりになる（並びは一覧ごとに比べない）。
describe('LU-12b: the base expectation that does not depend on the prior values (updateBasePayloadFieldsOf)', () => {
  const sorted = (names: readonly string[] | undefined): readonly string[] => [...(names ?? [])].sort();
  const pairsOf = (expectation: Pick<WritePayloadExpectation, 'checkboxPairs'>) =>
    [...(expectation.checkboxPairs ?? [])].map((pair) => JSON.stringify(pair)).sort();
  const fieldsOf = (fields: readonly { readonly name: string; readonly value: string }[] | undefined) =>
    [...(fields ?? [])].map((entry) => JSON.stringify([entry.name, entry.value])).sort();

  it('has only the parts that do not depend on the prior values', () => {
    const base = updateBasePayloadFieldsOf(specOf(), NEW_VALUES);
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    expect(base.fields.submittedFields).toEqual([{ name: 'customer_name', value: NEW_VALUES['customer_name'] }]);
    expect(base.fields.checkedPassthroughFields).toEqual([]);
    expect(base.fields.checkboxPairs).toEqual([]);
    expect(base.fields.absentFieldNames).toEqual(['archived_at']);
    expect(Object.isFrozen(base.fields)).toBe(true);
  });

  it('becomes the expectation of the current maker after the mark and the prior values are put in', () => {
    const spec = specOf();
    const base = updateBasePayloadFieldsOf(spec, NEW_VALUES);
    const mark = updateDeferredPriorValuesOf(spec, NEW_VALUES);
    const full = updatePayloadFieldsOf(spec, PRIOR, NEW_VALUES);
    if (!base.ok || !mark.ok || !full.ok) throw new Error('the expectations were not made');
    const request = { origin: ORIGIN, path: PATH, enctype: spec.enctype };
    const supplied = writeExpectationWithPriorValues({ request, ...base.fields, deferredPriorValues: mark.mark }, {
      keptFields: mark.mark.keptFieldNames.map((name) => ({ name, value: PRIOR.fields[name] ?? null })),
      checkedPassthroughFields: mark.mark.checkedPassthroughNames.map((name) => ({
        name, value: Object.hasOwn(PRIOR.stateHiddenValues, name) ? PRIOR.stateHiddenValues[name] ?? null : PRIOR.passthroughValues[name] ?? null,
      })),
      checkboxPairs: mark.mark.keptCheckboxPairNames.map((name) => ({ name, offValue: PRIOR.pairOffValues[name] ?? '', checkedValue: PRIOR.fields[name] ?? null })),
    });
    if (supplied === null) throw new Error('the prior values were not put in');
    expect(fieldsOf(supplied.submittedFields)).toEqual(fieldsOf(full.fields.submittedFields));
    expect(fieldsOf(supplied.checkedPassthroughFields)).toEqual(fieldsOf(full.fields.checkedPassthroughFields));
    expect(pairsOf(supplied)).toEqual(pairsOf(full.fields));
    expect(sorted(supplied.absentFieldNames)).toEqual(sorted(full.fields.absentFieldNames));
    expect(sorted(supplied.passthroughFieldNames)).toEqual(sorted(full.fields.passthroughFieldNames));
    expect(sorted(supplied.emptyFileFieldNames)).toEqual(sorted(full.fields.emptyFileFieldNames));
  });

  it('refuses the same inputs as the current maker', () => {
    expect(updateBasePayloadFieldsOf(specOf(), {})).toEqual({ ok: false, reason: 'SPEC_INVALID' });
    expect(updateBasePayloadFieldsOf(specOf(), { customer_name: null })).toEqual({ ok: false, reason: 'SPEC_INVALID' });
    expect(updateBasePayloadFieldsOf(specOf({ candidateFields: [...FIELDS, hiddenField('code')] }), NEW_VALUES))
      .toEqual({ ok: false, reason: 'SECRET_LIKE_PASSTHROUGH_FIELD' });
  });
});
