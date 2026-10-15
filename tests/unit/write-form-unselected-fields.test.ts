// T30f fix round 1（DEF-098。Task 30 の設計書 3 章の「送る中身の照合」「フォームの入力」）: 送る中身の照合の期待の作り手
// （`src/browser/write-form-submitter.ts` の `writeFormFieldListsOf`・`writePayloadFieldsOf`）が、送る欄に選ばなかった「見えていて編集できる欄」を
// どう期待に入れるかの表。
// - text 系（text・email・tel・password・textarea など。値が 1 つの欄）: 送る欄に値 `""` で入れる（ブラウザが空の値で送る。ページが値を入れれば
//   照合が `VALUE_MISMATCH` で止める）。
// - checkbox・radio（組でない）: 送らないことを期待する欄（`absentFieldNames`。radio の組は名前 1 つ）。
// - 同じ名前の hidden と checkbox の組で checkbox を選ばなかった: hidden の名前を名前だけの一覧に入れ、checkbox は送らない欄に入れない（本文に
//   名前が 1 回だけ出る）。checkbox を選んだ組は、今の扱いのまま。
// - disabled の欄（ブラウザが送らない）: どの一覧にも入れない。
// - select・select-multiple・range・color（既定の値が分からない）を選ばなかった、一覧の名前が重なる: 指定が正しくない（`SPEC_INVALID`。送らない）。
// - 作った期待は、本物の照合（`checkWritePayload`）で、ブラウザの形の本文を `ALLOW` にし、外れた本文を止める。
// - 送る欄だけの画面の一覧は、今の形のまま（新しい一覧は空）。
import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import {
  inspectWriteForm,
  writeFormFieldListsOf,
  writePayloadFieldsOf,
  type WriteFormFieldSpec,
  type WriteFormSpec,
} from '../../src/browser/write-form-submitter.js';
import { checkWritePayload, type WritePayloadDecision, type WriteRequestFacts } from '../../src/safety/write-payload-policy.js';

const ORIGIN = 'https://example.com';
const CREATE_PATH = '/members';
const URLENCODED = 'application/x-www-form-urlencoded';
const CSRF_MARKER = 'CSRF-MARKER-DEF098';
const READONLY_MARKER = 'RO-MARKER-DEF098';
const NAME_VALUE = '山田 太郎';

type Pair = readonly [name: string, value: string];

const field = (name: string, type: WriteFormFieldSpec['type'], flags: Partial<Pick<WriteFormFieldSpec, 'readonly' | 'hidden' | 'disabled'>> = {}): WriteFormFieldSpec =>
  ({ name, type, readonly: false, hidden: false, disabled: false, ...flags });

/** 任意の欄のある登録の画面の欄（候補の欄の順）。 */
const OPTIONAL_FIELDS: readonly WriteFormFieldSpec[] = [
  field('csrf_token', 'hidden', { hidden: true }),
  field('name', 'text'),
  field('nickname', 'text'),
  field('memo', 'textarea'),
  field('pin', 'password'),
  field('phone', 'tel'),
  field('agree', 'checkbox'),
  field('contact', 'radio'),
  field('contact', 'radio'),
  field('notify', 'hidden', { hidden: true }),
  field('notify', 'checkbox'),
  field('serial', 'text', { readonly: true }),
  field('att', 'file'),
  field('legacy', 'text', { disabled: true }),
];

const specOf = (candidateFields: readonly WriteFormFieldSpec[], submittedFieldNames: readonly string[]): WriteFormSpec => ({
  endpoint: { origin: ORIGIN, path: CREATE_PATH },
  enctype: URLENCODED,
  candidateFields,
  submittedFieldNames,
  methodOverride: null,
});

const encodeForm = (text: string): string => encodeURIComponent(text).split('%20').join('+');
const factsOf = (pairs: readonly Pair[]): WriteRequestFacts => ({
  method: 'POST',
  url: `${ORIGIN}${CREATE_PATH}`,
  isMainFrameNavigation: true,
  contentType: URLENCODED,
  hasPostData: true,
  postDataEntries: [{ bytes: Buffer.from(pairs.map(([name, value]) => `${encodeForm(name)}=${encodeForm(value)}`).join('&'), 'latin1').toString('base64') }],
  documentCharset: 'UTF-8',
});

/** ブラウザが送る本文（選ばなかった text 系は空、checkbox・radio はなし、組は hidden の値だけ、file は空、disabled はなし）。 */
const BROWSER_PAIRS: readonly Pair[] = [
  ['csrf_token', CSRF_MARKER],
  ['name', NAME_VALUE],
  ['nickname', ''],
  ['memo', ''],
  ['pin', ''],
  ['phone', ''],
  ['notify', '0'],
  ['serial', READONLY_MARKER],
  ['att', ''],
];

/** T31R-fix-1（C-1）: 値を照らす欄（秘密に見えない hidden・readonly・見えない欄）の、画面の確かめで読んだ値。 */
const PASSTHROUGH_VALUES = Object.freeze({ notify: '0', serial: READONLY_MARKER });

const checkOptional = (pairs: readonly Pair[]): WritePayloadDecision => {
  const spec = specOf(OPTIONAL_FIELDS, ['name']);
  const made = writePayloadFieldsOf(spec, { name: NAME_VALUE }, PASSTHROUGH_VALUES);
  if (!made.ok) {
    throw new Error('the expectation was not made');
  }
  return checkWritePayload({ request: { ...spec.endpoint, enctype: spec.enctype }, ...made.fields }, factsOf(pairs));
};

const withValue = (pairs: readonly Pair[], name: string, value: string): Pair[] =>
  pairs.map(([pairName, pairValue]) => [pairName, pairName === name ? value : pairValue] as const);
const without = (pairs: readonly Pair[], name: string): Pair[] => pairs.filter(([pairName]) => pairName !== name);

/** 指定の確かめだけで決まる結果（指定が正しければ page を読もうとして読めない。page は使わない形の偽物）。 */
const inspectSpecOnly = async (spec: WriteFormSpec): Promise<string> => {
  const inspection = await inspectWriteForm({} as Page, spec);
  return inspection.ok ? 'OK' : inspection.reason;
};

describe('DEF-098: the payload expectation for the visible, editable fields that are not chosen to send', () => {
  it('sends the unchosen text-like fields empty, expects the unchosen checkboxes and radios absent, and passes the hidden of an unchosen pair', () => {
    // T31R-fix-1（C-1）: 秘密に見えない組の hidden（`notify`）は値を照らす。秘密に見える名前（`csrf_token`・`code`）は名前だけ。
    expect(writeFormFieldListsOf(specOf(OPTIONAL_FIELDS, ['name']))).toEqual({
      // T31R2-fix-1（C-1）: 名前だけを照らすのは、ページが読み込みごとに作る値（CSRF）だけ。readonly の `serial` も値を照らす。disabled の
      // `legacy` は「送られない」。
      passthroughFieldNames: ['csrf_token'],
      emptyFileFieldNames: ['att'],
      methodOverride: null,
      emptyValueFieldNames: ['nickname', 'memo', 'pin', 'phone'],
      absentFieldNames: ['agree', 'contact', 'legacy'],
      checkedPassthroughFieldNames: ['notify', 'serial'],
    });
    expect(writePayloadFieldsOf(specOf(OPTIONAL_FIELDS, ['name']), { name: NAME_VALUE }, PASSTHROUGH_VALUES)).toEqual({
      ok: true,
      fields: {
        submittedFields: [
          { name: 'name', value: NAME_VALUE },
          { name: 'nickname', value: '' },
          { name: 'memo', value: '' },
          { name: 'pin', value: '' },
          { name: 'phone', value: '' },
        ],
        passthroughFieldNames: ['csrf_token'],
        emptyFileFieldNames: ['att'],
        methodOverride: null,
        absentFieldNames: ['agree', 'contact', 'legacy'],
        checkedPassthroughFields: [{ name: 'notify', value: '0' }, { name: 'serial', value: READONLY_MARKER }],
      },
    });
    // 値を照らす欄の値がそろわなければ、期待を作らない。
    expect(writePayloadFieldsOf(specOf(OPTIONAL_FIELDS, ['name']), { name: NAME_VALUE }, {})).toEqual({ ok: false, reason: 'SPEC_INVALID' });
  });

  it('keeps the current handling of a chosen pair checkbox (its hidden is not a passthrough name)', () => {
    expect(writeFormFieldListsOf(specOf(OPTIONAL_FIELDS, ['name', 'notify']))).toMatchObject({
      passthroughFieldNames: ['csrf_token'],
      absentFieldNames: ['agree', 'contact', 'legacy'],
    });
  });

  it('keeps the lists of a form whose visible fields are all chosen (the new lists are empty)', () => {
    const fields = [field('csrf_token', 'hidden', { hidden: true }), field('name', 'text'), field('agree', 'checkbox'), field('plan', 'select-one')];
    expect(writeFormFieldListsOf(specOf(fields, ['name', 'agree', 'plan']))).toEqual({
      passthroughFieldNames: ['csrf_token'],
      emptyFileFieldNames: [],
      methodOverride: null,
      emptyValueFieldNames: [],
      absentFieldNames: [],
      checkedPassthroughFieldNames: [],
    });
  });

  it.each<[string, readonly Pair[], WritePayloadDecision]>([
    ['the body the browser sends', BROWSER_PAIRS, 'ALLOW'],
    ['a value the page put in an unchosen text field', withValue(BROWSER_PAIRS, 'nickname', 'page'), 'VALUE_MISMATCH'],
    ['a value the page put in an unchosen textarea', withValue(BROWSER_PAIRS, 'memo', 'page'), 'VALUE_MISMATCH'],
    ['an unchosen checkbox the page checked', [...BROWSER_PAIRS, ['agree', 'on']], 'UNEXPECTED_FIELD_PRESENT'],
    ['an unchosen radio the page selected', [...BROWSER_PAIRS, ['contact', 'phone']], 'UNEXPECTED_FIELD_PRESENT'],
    // T31R-fix-1（C-1）: 組の hidden は値を照らすので、ページがチェックした組の checkbox（同じ名前の 2 つ目）は値を照らす欄の違いで止まる。
    ['the checkbox of an unchosen pair the page checked', [...BROWSER_PAIRS, ['notify', '1']], 'PASSTHROUGH_VALUE_MISMATCH'],
    ['a value the page put in the hidden of an unchosen pair', withValue(BROWSER_PAIRS, 'notify', '1'), 'PASSTHROUGH_VALUE_MISMATCH'],
    // T31R2-fix-1（C-1）: disabled の欄は「送られない」（ページが有効にして値を入れると止まる）。
    ['a disabled field the page enabled', [...BROWSER_PAIRS, ['legacy', 'x']], 'UNEXPECTED_FIELD_PRESENT'],
    ['an unchosen text field missing from the body', without(BROWSER_PAIRS, 'nickname'), 'SUBMITTED_FIELD_MISSING'],
  ])('checks %s', (_label, pairs, expected) => {
    expect(checkOptional(pairs)).toBe(expected);
  });

  it.each<[string, readonly WriteFormFieldSpec[], readonly string[], string]>([
    ['an unchosen select-one', [field('name', 'text'), field('plan', 'select-one')], ['name'], 'SPEC_INVALID'],
    ['an unchosen select-multiple', [field('name', 'text'), field('tags', 'select-multiple')], ['name'], 'SPEC_INVALID'],
    ['an unchosen range', [field('name', 'text'), field('level', 'range')], ['name'], 'SPEC_INVALID'],
    ['an unchosen color', [field('name', 'text'), field('tint', 'color')], ['name'], 'SPEC_INVALID'],
    ['an unchosen text field with the name of a hidden field', [field('name', 'text'), field('x', 'hidden', { hidden: true }), field('x', 'text')], ['name'],
      'SPEC_INVALID'],
    ['a chosen select', [field('name', 'text'), field('plan', 'select-one')], ['name', 'plan'], 'FORM_UNREADABLE'],
    ['an unchosen disabled select', [field('name', 'text'), field('plan', 'select-one', { disabled: true })], ['name'], 'FORM_UNREADABLE'],
    ['an unchosen invisible select', [field('name', 'text'), field('plan', 'select-one', { hidden: true })], ['name'], 'FORM_UNREADABLE'],
    ['unchosen text fields, checkboxes, radios and a pair', OPTIONAL_FIELDS, ['name'], 'FORM_UNREADABLE'],
  ])('checks the specification with %s', async (_label, fields, submitted, expected) => {
    expect(await inspectSpecOnly(specOf(fields, submitted))).toBe(expected);
  });
});

// T31R2-fix-1（C-1。DEF-108 の残り）: 値を照らす判定の外だった形（見えない checkbox・select、disabled の欄、秘密に見える名前の一般の名前）。
describe('T31R2-fix-1: the invisible choices, the disabled fields and the secret-like names in the payload expectation of a create', () => {
  const E8_FIELDS: readonly WriteFormFieldSpec[] = [
    field('csrf_token', 'hidden', { hidden: true }),
    field('name', 'text'),
    field('member[_destroy]', 'checkbox', { hidden: true }),
    field('group_id', 'select-one', { hidden: true }),
    field('parent_id', 'hidden', { hidden: true, disabled: true }),
  ];

  it('reads the invisible checkbox and select (the value, or not sent), and expects the disabled field not sent', () => {
    expect(writeFormFieldListsOf(specOf(E8_FIELDS, ['name']))).toMatchObject({
      passthroughFieldNames: ['csrf_token'],
      absentFieldNames: ['parent_id'],
      checkedPassthroughFieldNames: ['member[_destroy]', 'group_id'],
    });
    expect(writePayloadFieldsOf(specOf(E8_FIELDS, ['name']), { name: NAME_VALUE }, { 'member[_destroy]': null, group_id: 'g-1' })).toMatchObject({
      ok: true,
      fields: { absentFieldNames: ['parent_id', 'member[_destroy]'], checkedPassthroughFields: [{ name: 'group_id', value: 'g-1' }] },
    });
    expect(writePayloadFieldsOf(specOf(E8_FIELDS, ['name']), { name: NAME_VALUE }, { 'member[_destroy]': '1', group_id: 'g-1' })).toMatchObject({
      ok: true,
      fields: { absentFieldNames: ['parent_id'], checkedPassthroughFields: [{ name: 'member[_destroy]', value: '1' }, { name: 'group_id', value: 'g-1' }] },
    });
    // 値が 1 つの欄（hidden・text 系）は「送られない」にできない。
    expect(writePayloadFieldsOf(specOf([...E8_FIELDS, field('owner_id', 'hidden', { hidden: true })], ['name']), { name: NAME_VALUE },
      { 'member[_destroy]': null, group_id: 'g-1', owner_id: null })).toEqual({ ok: false, reason: 'SPEC_INVALID' });
  });

  it.each<[string, readonly WriteFormFieldSpec[], string]>([
    ['a hidden code', [field('name', 'text'), field('code', 'hidden', { hidden: true })], 'SECRET_LIKE_PASSTHROUGH_FIELD'],
    ['a readonly key', [field('name', 'text'), field('key', 'text', { readonly: true })], 'SECRET_LIKE_PASSTHROUGH_FIELD'],
    ['an invisible ticket', [field('name', 'text'), field('ticket', 'text', { hidden: true })], 'SECRET_LIKE_PASSTHROUGH_FIELD'],
    ['an invisible select-multiple', [field('name', 'text'), field('tags', 'select-multiple', { hidden: true })], 'SPEC_INVALID'],
    ['a disabled field with the name of another hidden field', [field('name', 'text'), field('x', 'hidden', { hidden: true }),
      field('x', 'text', { disabled: true })], 'SPEC_INVALID'],
    ['the CSRF hidden, the invisible choices and the disabled field', E8_FIELDS, 'FORM_UNREADABLE'],
  ])('checks the specification with %s', async (_label, fields, expected) => {
    expect(await inspectSpecOnly(specOf(fields, ['name']))).toBe(expected);
  });
});
