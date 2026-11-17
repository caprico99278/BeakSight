// T31c（Task 31 の設計書 3 章の「欄の役割」「削除にあたる変更の遮断」の送る中身の照合、「同じ名前の hidden と checkbox の組」「値の照らし方」、
// 4 章の「照合」）: 書き込みの段の送る中身の照合（`checkWritePayload`。`src/safety/write-payload-policy.ts`）を、UPDATE の画面に広げた形の表。
// - 保つ見える欄: 送る欄（`submittedFields`）と同じ扱い（名前があり、値が前の値と完全に一致。改行は CR LF にした形）。新しい仕組みは作らない。
// - 送らないことを期待する欄（`absentFieldNames`）: 本文にあれば `UNEXPECTED_FIELD_PRESENT`。
// - 値を照らす hidden の欄（`checkedPassthroughFields`）: 本文にちょうど 1 つ、file の部品でなく、値が完全に一致。外れたら `PASSTHROUGH_VALUE_MISMATCH`。
// - 同じ名前の hidden と checkbox の組（`checkboxPairs`）: 本文に「`offValue` の 1 つだけ」か「`offValue`、`checkedValue` の順の 2 つだけ」。
//   外れたら `CHECKBOX_PAIR_MISMATCH`。
// - 名前は、すべての一覧を通して重ならない（組の名前も）。method の上書きの欄（`_method`）は、どの一覧にも入れない。外れた指定は `EXPECTATION_INVALID`。
// - 新しい項目を指定しなければ、今の CREATE の照合と同じ（空の一覧と省略は同じ結果）。
// - urlencoded と multipart の両方。例の値は、匿名の値（`example.com`）だけを使う。
import { describe, expect, it } from 'vitest';
import {
  WRITE_PAYLOAD_DECISIONS,
  checkWritePayload,
  writeExpectationWithPriorValues,
  type WritePayloadDecision,
  type WritePayloadExpectation,
  type WriteRequestFacts,
  type WriteSuppliedPriorValues,
} from '../../src/safety/write-payload-policy.js';

const ORIGIN = 'https://example.com';
const RECORD_PATH = '/records/7';
const URLENCODED = 'application/x-www-form-urlencoded';
const MULTIPART = 'multipart/form-data';
const BOUNDARY = '----WebKitFormBoundaryUpd31c';
const MULTIPART_CONTENT_TYPE = `multipart/form-data; boundary=${BOUNDARY}`;
/** CSRF のトークンの目印の値（名前だけを照らす。結果に出ない）。 */
const CSRF_MARKER = 'CSRF-MARKER-31c';
const NEW_NAME = '佐藤 花子';
/** 保つ欄の前の値（期待は LF、本文はブラウザが CR LF にした形）。 */
const KEPT_MEMO = '一行目\n二行目';
const KEPT_MEMO_IN_BODY = '一行目\r\n二行目';

type Enctype = typeof URLENCODED | typeof MULTIPART;
type Pair = readonly [name: string, value: string];

const expectationOf = (enctype: Enctype, extra: Partial<WritePayloadExpectation> = {}): WritePayloadExpectation => ({
  request: { origin: ORIGIN, path: RECORD_PATH, enctype },
  submittedFields: [
    { name: 'customer_name', value: NEW_NAME },
    { name: 'memo', value: KEPT_MEMO },
  ],
  passthroughFieldNames: ['authenticity_token', 'lock_version'],
  emptyFileFieldNames: [],
  methodOverride: 'PATCH',
  checkedPassthroughFields: [{ name: 'status', value: 'active' }],
  checkboxPairs: [{ name: 'published', offValue: '0', checkedValue: '1' }],
  absentFieldNames: ['notify'],
  ...extra,
});

/** 承認の形の本文の欄（ブラウザの順。組の hidden は checkbox の直前）。 */
const VALID_PAIRS: readonly Pair[] = [
  ['_method', 'PATCH'],
  ['authenticity_token', CSRF_MARKER],
  ['customer_name', NEW_NAME],
  ['memo', KEPT_MEMO_IN_BODY],
  ['status', 'active'],
  ['published', '0'],
  ['published', '1'],
  ['lock_version', '3'],
];

const encodeForm = (text: string): string => encodeURIComponent(text).split('%20').join('+');
const urlencodedBody = (pairs: readonly Pair[]): string => pairs.map(([name, value]) => `${encodeForm(name)}=${encodeForm(value)}`).join('&');
const utf8AsLatin1 = (text: string): string => Buffer.from(text, 'utf8').toString('latin1');
interface Part { readonly header: string; readonly content: string }
const textPart = ([name, value]: Pair): Part => ({ header: `Content-Disposition: form-data; name="${utf8AsLatin1(name)}"`, content: utf8AsLatin1(value) });
const filePart = (name: string): Part => ({
  header: `Content-Disposition: form-data; name="${name}"; filename=""\r\nContent-Type: application/octet-stream`,
  content: '',
});
const multipartBody = (parts: readonly Part[]): string =>
  `${parts.map((part) => `--${BOUNDARY}\r\n${part.header}\r\n\r\n${part.content}\r\n`).join('')}--${BOUNDARY}--\r\n`;

const factsOf = (contentType: string, body: string): WriteRequestFacts => ({
  method: 'POST',
  url: `${ORIGIN}${RECORD_PATH}`,
  isMainFrameNavigation: true,
  contentType,
  hasPostData: true,
  postDataEntries: [{ bytes: Buffer.from(body, 'latin1').toString('base64') }],
  documentCharset: 'UTF-8',
});

/** 本文の欄の並びを、その enctype の本文の事実にする。 */
const bodyFacts = (enctype: Enctype, pairs: readonly Pair[]): WriteRequestFacts => (enctype === URLENCODED
  ? factsOf(URLENCODED, urlencodedBody(pairs))
  : factsOf(MULTIPART_CONTENT_TYPE, multipartBody(pairs.map(textPart))));

const check = (expectation: WritePayloadExpectation, facts: WriteRequestFacts): WritePayloadDecision => checkWritePayload(expectation, facts);

/** 名前 `name` の欄をすべて除いた並び。 */
const without = (pairs: readonly Pair[], name: string): Pair[] => pairs.filter(([pairName]) => pairName !== name);
/** 名前 `name` の欄の値を変えた並び（同じ名前のすべて）。 */
const withValue = (pairs: readonly Pair[], name: string, value: string): Pair[] =>
  pairs.map(([pairName, pairValue]) => [pairName, pairName === name ? value : pairValue] as const);
/** `name` の最初の欄の後に、欄を足した並び。 */
const insertAfter = (pairs: readonly Pair[], name: string, added: readonly Pair[]): Pair[] => {
  const index = pairs.findIndex(([pairName]) => pairName === name);
  return [...pairs.slice(0, index + 1), ...added, ...pairs.slice(index + 1)];
};
/** 組の欄（`published`）を、指定した値の並びに置き換えた並び（最初の組の欄の位置に入れる）。 */
const withPair = (pairs: readonly Pair[], values: readonly string[]): Pair[] => {
  const index = pairs.findIndex(([name]) => name === 'published');
  const rest = without(pairs, 'published');
  return [...rest.slice(0, index), ...values.map((value) => ['published', value] as const), ...rest.slice(index)];
};

const ENCTYPES: readonly Enctype[] = [URLENCODED, MULTIPART];

describe('T31c: the closed list of the decisions', () => {
  it('adds the three reasons of the update payload at the end', () => {
    expect(WRITE_PAYLOAD_DECISIONS.slice(-3)).toEqual(['UNEXPECTED_FIELD_PRESENT', 'PASSTHROUGH_VALUE_MISMATCH', 'CHECKBOX_PAIR_MISMATCH']);
  });
});

describe.each(ENCTYPES)('T31c: the update payload, %s', (enctype) => {
  const expectation = expectationOf(enctype);

  it('allows the approved body (kept values, the checked hidden value, the pair and no absent field)', () => {
    expect(check(expectation, bodyFacts(enctype, VALID_PAIRS))).toBe('ALLOW');
  });

  it.each<[string, readonly Pair[], WritePayloadDecision]>([
    // 保つ見える欄（送る欄と同じ扱い）
    ['a kept value that the page changed', withValue(VALID_PAIRS, 'memo', '書き換え'), 'VALUE_MISMATCH'],
    ['a kept value with LF where the browser sends CR LF', withValue(VALID_PAIRS, 'memo', KEPT_MEMO), 'VALUE_MISMATCH'],
    ['a kept value with a trailing space', withValue(VALID_PAIRS, 'memo', `${KEPT_MEMO_IN_BODY} `), 'VALUE_MISMATCH'],
    ['a missing kept field', without(VALID_PAIRS, 'memo'), 'SUBMITTED_FIELD_MISSING'],
    ['a kept field twice', insertAfter(VALID_PAIRS, 'memo', [['memo', KEPT_MEMO_IN_BODY]]), 'DUPLICATE_FIELD'],
    // 送らないことを期待する欄
    ['an absent field that the page checked', [...VALID_PAIRS, ['notify', '1']], 'UNEXPECTED_FIELD_PRESENT'],
    ['an absent field with an empty value', [...VALID_PAIRS, ['notify', '']], 'UNEXPECTED_FIELD_PRESENT'],
    ['an absent field at the start', [['notify', '1'], ...VALID_PAIRS], 'UNEXPECTED_FIELD_PRESENT'],
    // 値を照らす hidden の欄
    ['the state hidden set to another value', withValue(VALID_PAIRS, 'status', 'inactive'), 'PASSTHROUGH_VALUE_MISMATCH'],
    ['the state hidden set to 0', withValue(VALID_PAIRS, 'status', '0'), 'PASSTHROUGH_VALUE_MISMATCH'],
    ['the state hidden in another case (exact match)', withValue(VALID_PAIRS, 'status', 'ACTIVE'), 'PASSTHROUGH_VALUE_MISMATCH'],
    ['the state hidden with a trailing space', withValue(VALID_PAIRS, 'status', 'active '), 'PASSTHROUGH_VALUE_MISMATCH'],
    ['the state hidden emptied', withValue(VALID_PAIRS, 'status', ''), 'PASSTHROUGH_VALUE_MISMATCH'],
    ['a missing state hidden', without(VALID_PAIRS, 'status'), 'PASSTHROUGH_VALUE_MISMATCH'],
    ['the state hidden twice (same value)', insertAfter(VALID_PAIRS, 'status', [['status', 'active']]), 'PASSTHROUGH_VALUE_MISMATCH'],
    ['the state hidden twice (another value after)', insertAfter(VALID_PAIRS, 'status', [['status', 'deleted']]), 'PASSTHROUGH_VALUE_MISMATCH'],
    // 組
    ['the pair unchecked by the page', withPair(VALID_PAIRS, ['0']), 'CHECKBOX_PAIR_MISMATCH'],
    ['the pair in the reverse order', withPair(VALID_PAIRS, ['1', '0']), 'CHECKBOX_PAIR_MISMATCH'],
    ['the pair three times', withPair(VALID_PAIRS, ['0', '1', '1']), 'CHECKBOX_PAIR_MISMATCH'],
    ['the pair with another hidden before', withPair(VALID_PAIRS, ['0', '0', '1']), 'CHECKBOX_PAIR_MISMATCH'],
    ['the pair with another off value', withPair(VALID_PAIRS, ['false', '1']), 'CHECKBOX_PAIR_MISMATCH'],
    ['the pair with another checked value', withPair(VALID_PAIRS, ['0', 'yes']), 'CHECKBOX_PAIR_MISMATCH'],
    ['the pair with the checkbox only', withPair(VALID_PAIRS, ['1']), 'CHECKBOX_PAIR_MISMATCH'],
    ['the pair missing', withPair(VALID_PAIRS, []), 'CHECKBOX_PAIR_MISMATCH'],
  ])('blocks %s', (_name, pairs, expected) => {
    expect(check(expectation, bodyFacts(enctype, pairs))).toBe(expected);
  });

  it('allows the unchecked pair (only the off value) when the expectation is unchecked, and blocks the checked pair then', () => {
    const unchecked = expectationOf(enctype, { checkboxPairs: [{ name: 'published', offValue: '0', checkedValue: null }] });
    expect(check(unchecked, bodyFacts(enctype, withPair(VALID_PAIRS, ['0'])))).toBe('ALLOW');
    expect(check(unchecked, bodyFacts(enctype, VALID_PAIRS))).toBe('CHECKBOX_PAIR_MISMATCH');
    expect(check(unchecked, bodyFacts(enctype, withPair(VALID_PAIRS, ['0', '0'])))).toBe('CHECKBOX_PAIR_MISMATCH');
    expect(check(unchecked, bodyFacts(enctype, withPair(VALID_PAIRS, [])))).toBe('CHECKBOX_PAIR_MISMATCH');
  });

  it('allows the pair when other fields come between the hidden and the checkbox (only the order of the pair matters)', () => {
    // 組の hidden と checkbox の間に `lock_version` を置く（`lock_version` は 1 回だけ）。
    const between = insertAfter(without(VALID_PAIRS, 'lock_version'), 'published', [['lock_version', '3']]);
    expect(between.map(([name]) => name).slice(-3)).toEqual(['published', 'lock_version', 'published']);
    expect(check(expectation, bodyFacts(enctype, between))).toBe('ALLOW');
  });

  it('compares the values of the checked hidden and the pair with line breaks normalized to CR LF', () => {
    const lines = expectationOf(enctype, {
      checkedPassthroughFields: [{ name: 'status', value: 'a\nb' }],
      checkboxPairs: [{ name: 'published', offValue: 'x\ny', checkedValue: 'p\rq' }],
    });
    const body = withPair(withValue(VALID_PAIRS, 'status', 'a\r\nb'), ['x\r\ny', 'p\r\nq']);
    expect(check(lines, bodyFacts(enctype, body))).toBe('ALLOW');
    expect(check(lines, bodyFacts(enctype, withValue(body, 'status', 'a\nb')))).toBe('PASSTHROUGH_VALUE_MISMATCH');
  });
});

describe('T31c: file parts in the multipart body', () => {
  const expectation = expectationOf(MULTIPART);
  const partsWith = (name: string): Part[] => VALID_PAIRS.map((pair) => (pair[0] === name ? filePart(name) : textPart(pair)));

  it('blocks the checked hidden as a file part', () => {
    expect(check(expectation, factsOf(MULTIPART_CONTENT_TYPE, multipartBody(partsWith('status'))))).toBe('PASSTHROUGH_VALUE_MISMATCH');
  });

  it('blocks the pair as a file part', () => {
    expect(check(expectation, factsOf(MULTIPART_CONTENT_TYPE, multipartBody(partsWith('published'))))).toBe('CHECKBOX_PAIR_MISMATCH');
  });

  it('blocks the absent field as a file part', () => {
    const parts = [...VALID_PAIRS.map(textPart), filePart('notify')];
    expect(check(expectation, factsOf(MULTIPART_CONTENT_TYPE, multipartBody(parts)))).toBe('UNEXPECTED_FIELD_PRESENT');
  });
});

describe('T31c: invalid expectations of the update payload', () => {
  const body = bodyFacts(URLENCODED, VALID_PAIRS);

  it.each<[string, Partial<WritePayloadExpectation>]>([
    ['an absent name that is also submitted', { absentFieldNames: ['notify', 'memo'] }],
    ['an absent name that is also a passthrough name', { absentFieldNames: ['lock_version'] }],
    ['a checked hidden name that is also a passthrough name', { checkedPassthroughFields: [{ name: 'lock_version', value: '3' }] }],
    ['a checked hidden name that is also submitted', { checkedPassthroughFields: [{ name: 'memo', value: KEPT_MEMO }] }],
    ['a checked hidden name twice', { checkedPassthroughFields: [{ name: 'status', value: 'active' }, { name: 'status', value: 'active' }] }],
    ['a pair name that is also absent', { absentFieldNames: ['published'] }],
    ['a pair name that is also a checked hidden', { checkedPassthroughFields: [{ name: 'published', value: '0' }] }],
    ['a pair name that is also a passthrough name', { passthroughFieldNames: ['authenticity_token', 'published'] }],
    ['a pair name that is also submitted', { submittedFields: [{ name: 'customer_name', value: NEW_NAME }, { name: 'published', value: '1' }] }],
    ['a pair name twice', { checkboxPairs: [{ name: 'published', offValue: '0', checkedValue: '1' }, { name: 'published', offValue: '0', checkedValue: null }] }],
    ['the override field as absent', { absentFieldNames: ['_method'] }],
    ['the override field as a checked hidden', { checkedPassthroughFields: [{ name: '_METHOD', value: 'PATCH' }] }],
    ['the override field as a pair', { checkboxPairs: [{ name: '_method', offValue: 'PATCH', checkedValue: null }] }],
    ['an empty absent name', { absentFieldNames: [''] }],
    ['absent names that are not a list', { absentFieldNames: 'notify' as never }],
    ['checked hidden fields that are not a list', { checkedPassthroughFields: { name: 'status', value: 'active' } as never }],
    ['a checked hidden value that is not a string', { checkedPassthroughFields: [{ name: 'status', value: 1 as never }] }],
    ['a checked hidden with an empty name', { checkedPassthroughFields: [{ name: '', value: 'active' }] }],
    ['a checked hidden value with a lone surrogate', { checkedPassthroughFields: [{ name: 'status', value: '\uD800' }] }],
    ['pairs that are not a list', { checkboxPairs: 'published' as never }],
    ['a pair without an off value', { checkboxPairs: [{ name: 'published', checkedValue: '1' } as never] }],
    ['a pair with an undefined checked value', { checkboxPairs: [{ name: 'published', offValue: '0' } as never] }],
    ['a pair with a numeric checked value', { checkboxPairs: [{ name: 'published', offValue: '0', checkedValue: 1 as never }] }],
    ['a pair with an empty name', { checkboxPairs: [{ name: '', offValue: '0', checkedValue: '1' }] }],
  ])('treats %s as an invalid expectation', (_name, extra) => {
    expect(check(expectationOf(URLENCODED, extra), body)).toBe('EXPECTATION_INVALID');
  });
});

describe('T31c: the create payload does not change', () => {
  const createExpectation = (extra: Partial<WritePayloadExpectation> = {}): WritePayloadExpectation => ({
    request: { origin: ORIGIN, path: '/items', enctype: URLENCODED },
    submittedFields: [{ name: 'customer_name', value: NEW_NAME }],
    passthroughFieldNames: ['csrf_token'],
    emptyFileFieldNames: [],
    ...extra,
  });
  const createFacts = (pairs: readonly Pair[]): WriteRequestFacts => ({ ...factsOf(URLENCODED, urlencodedBody(pairs)), url: `${ORIGIN}/items` });

  it('gives the same decisions with the new items omitted or empty', () => {
    const bodies: readonly (readonly Pair[])[] = [
      [['csrf_token', CSRF_MARKER], ['customer_name', NEW_NAME]],
      [['customer_name', NEW_NAME]],
      [['csrf_token', CSRF_MARKER], ['customer_name', 'x']],
      [['csrf_token', CSRF_MARKER], ['customer_name', NEW_NAME], ['customer_name', NEW_NAME]],
      [['csrf_token', CSRF_MARKER], ['customer_name', NEW_NAME], ['published', '0'], ['published', '1']],
      [['csrf_token', CSRF_MARKER], ['customer_name', NEW_NAME], ['status', 'active']],
      [['csrf_token', CSRF_MARKER]],
    ];
    const expectedDecisions: readonly WritePayloadDecision[] = [
      'ALLOW', 'ALLOW', 'VALUE_MISMATCH', 'DUPLICATE_FIELD', 'UNKNOWN_FIELD', 'UNKNOWN_FIELD', 'SUBMITTED_FIELD_MISSING',
    ];
    bodies.forEach((pairs, index) => {
      const omitted = check(createExpectation(), createFacts(pairs));
      expect(omitted, JSON.stringify(pairs)).toBe(expectedDecisions[index]);
      expect(check(createExpectation({ absentFieldNames: [], checkedPassthroughFields: [], checkboxPairs: [] }), createFacts(pairs))).toBe(omitted);
    });
  });

  it('accepts a Rails-style pair in a create form when the expectation has it', () => {
    const expectation = createExpectation({ checkboxPairs: [{ name: 'agree', offValue: '0', checkedValue: '1' }] });
    expect(check(expectation, createFacts([['csrf_token', CSRF_MARKER], ['customer_name', NEW_NAME], ['agree', '0'], ['agree', '1']]))).toBe('ALLOW');
    expect(check(expectation, createFacts([['csrf_token', CSRF_MARKER], ['customer_name', NEW_NAME], ['agree', '0']]))).toBe('CHECKBOX_PAIR_MISMATCH');
  });
});

describe('T31c: the values do not appear in the decision', () => {
  it('returns only a decision word for the blocked update bodies', () => {
    const marker = 'STATE-MARKER-31c';
    for (const enctype of ENCTYPES) {
      for (const pairs of [withValue(VALID_PAIRS, 'status', marker), withPair(VALID_PAIRS, [marker, '1']), [...VALID_PAIRS, ['notify', marker] as const]]) {
        const decision = check(expectationOf(enctype), bodyFacts(enctype, pairs));
        expect(WRITE_PAYLOAD_DECISIONS).toContain(decision);
        expect(decision).not.toBe('ALLOW');
        expect(JSON.stringify(decision)).not.toContain(marker);
        expect(JSON.stringify(decision)).not.toContain(CSRF_MARKER);
      }
    }
  });
});

// LU-12a（設計書 `2026-11-02-beaksight-list-row-update-design.md` 4.0.1 の K1、5.3 の 2・5.5。LU-9 の API の形と同じ約束）: 前の値を後から入れる印
// （`deferredPriorValues`）のあるフォームの期待。印のある期待は、前の値を入れるまで照合が `EXPECTATION_INVALID` で止める（fail-closed）。入れられるのは値だけで、
// 鍵の集合（保つ見える欄・値を照らす hidden・組の名前）は期待を作る時に決まる。値の形は、今の期待の確かめ（`isValidExpectation`）で確かめる。
describe.each(ENCTYPES)('LU-12a: the form expectation whose prior values are supplied later, %s', (enctype) => {
  /** 前の値に頼る欄（保つ `memo`、状態の hidden `status`、組 `published`）を持たない、印のある期待。 */
  const deferredOf = (extra: Partial<WritePayloadExpectation> = {}): WritePayloadExpectation => expectationOf(enctype, {
    submittedFields: [{ name: 'customer_name', value: NEW_NAME }],
    checkedPassthroughFields: undefined,
    checkboxPairs: undefined,
    deferredPriorValues: { keptFieldNames: ['memo'], checkedPassthroughNames: ['status'], keptCheckboxPairNames: ['published'], changedCheckboxPairs: [], nullableFieldNames: [] },
    ...extra,
  });
  const markOf = (mark: Partial<NonNullable<WritePayloadExpectation['deferredPriorValues']>>): NonNullable<WritePayloadExpectation['deferredPriorValues']> => ({
    keptFieldNames: ['memo'], checkedPassthroughNames: ['status'], keptCheckboxPairNames: ['published'], changedCheckboxPairs: [], nullableFieldNames: [], ...mark,
  });
  const SUPPLIED: WriteSuppliedPriorValues = Object.freeze({
    keptFields: [{ name: 'memo', value: KEPT_MEMO }],
    checkedPassthroughFields: [{ name: 'status', value: 'active' }],
    checkboxPairs: [{ name: 'published', offValue: '0', checkedValue: '1' }],
  });
  const supplied = (expectation: WritePayloadExpectation = deferredOf(), prior: unknown = SUPPLIED): WritePayloadExpectation | null =>
    writeExpectationWithPriorValues(expectation, prior as WriteSuppliedPriorValues);

  it('blocks the approved body with EXPECTATION_INVALID before the prior values are supplied (fail-closed)', () => {
    expect(check(deferredOf(), bodyFacts(enctype, VALID_PAIRS))).toBe('EXPECTATION_INVALID');
  });

  it('allows the approved body after the prior values are supplied, and blocks a changed prior value with the current reason', () => {
    const expectation = supplied();
    expect(expectation).not.toBeNull();
    if (expectation === null) return;
    expect(expectation.deferredPriorValues).toBeUndefined();
    expect(check(expectation, bodyFacts(enctype, VALID_PAIRS))).toBe('ALLOW');
    expect(check(expectation, bodyFacts(enctype, withValue(VALID_PAIRS, 'memo', '書き換え')))).toBe('VALUE_MISMATCH');
    expect(check(expectation, bodyFacts(enctype, withValue(VALID_PAIRS, 'status', 'deleted')))).toBe('PASSTHROUGH_VALUE_MISMATCH');
    expect(check(expectation, bodyFacts(enctype, withPair(VALID_PAIRS, ['false', '1'])))).toBe('CHECKBOX_PAIR_MISMATCH');
    expect(check(expectation, bodyFacts(enctype, withPair(VALID_PAIRS, ['0'])))).toBe('CHECKBOX_PAIR_MISMATCH');
    expect(check(expectation, bodyFacts(enctype, [...VALID_PAIRS, ['notify', '1']]))).toBe('UNEXPECTED_FIELD_PRESENT');
    // 元の期待は変わらない（印のまま。純粋）。
    expect(check(deferredOf(), bodyFacts(enctype, VALID_PAIRS))).toBe('EXPECTATION_INVALID');
  });

  it('expects a prior value of null not to be sent for the fields that the mark allows null (a checkbox, a radio or a select that the browser does not send)', () => {
    const nullable = deferredOf({ deferredPriorValues: markOf({ nullableFieldNames: ['memo', 'status'] }) });
    const expectation = supplied(nullable, { ...SUPPLIED, keptFields: [{ name: 'memo', value: null }], checkedPassthroughFields: [{ name: 'status', value: null }] });
    if (expectation === null) throw new Error('not supplied');
    const sent = without(without(VALID_PAIRS, 'memo'), 'status');
    expect(check(expectation, bodyFacts(enctype, sent))).toBe('ALLOW');
    expect(check(expectation, bodyFacts(enctype, VALID_PAIRS))).toBe('UNEXPECTED_FIELD_PRESENT');
  });

  // fix round 1（設計者の判断 (b)）: null を許すのは、印の `nullableFieldNames`（承認の時の欄の種類から作る。checkbox・radio・select だけ）の欄だけ。text の
  // 欄などに null を入れる入力は拒む（ページがその欄を外して送る本文を通さない）。
  it.each<[string, Partial<WriteSuppliedPriorValues>]>([
    ['a kept text field', { keptFields: [{ name: 'memo', value: null }] }],
    ['a checked hidden field', { checkedPassthroughFields: [{ name: 'status', value: null }] }],
  ])('rejects a null prior value for %s that the mark does not allow null', (_label, override) => {
    expect(supplied(deferredOf(), { ...SUPPLIED, ...override })).toBeNull();
    // 許す欄が別の一覧の欄でも拒む（名前ごと）。
    expect(supplied(deferredOf({ deferredPriorValues: markOf({ nullableFieldNames: ['customer_name'] }) }), { ...SUPPLIED, ...override })).toBeNull();
  });

  it.each<[string, readonly unknown[]]>([
    ['a name that is not a kept field or a checked hidden', ['notify']],
    ['a pair name', ['published']],
    ['a name twice', ['memo', 'memo']],
    ['an empty name', ['']],
  ])('rejects a mark whose null-allowed names have %s', (_label, names) => {
    expect(supplied(deferredOf({ deferredPriorValues: markOf({ nullableFieldNames: names as string[] }) }))).toBeNull();
  });

  it('rejects a mark without the null-allowed names (fail-closed)', () => {
    const { nullableFieldNames: _names, ...withoutNames } = markOf({});
    expect(supplied(deferredOf({ deferredPriorValues: withoutNames as NonNullable<WritePayloadExpectation['deferredPriorValues']> }))).toBeNull();
  });

  it('takes the changed pair checked value from the expectation and only the off value from the supplied prior values', () => {
    const changed = deferredOf({ deferredPriorValues: markOf({ keptCheckboxPairNames: [], changedCheckboxPairs: [{ name: 'published', checkedValue: '1' }] }) });
    const expectation = supplied(changed);
    expect(expectation === null ? null : check(expectation, bodyFacts(enctype, VALID_PAIRS))).toBe('ALLOW');
    // 変える組の checkbox の値が期待の値と違えば拒む（前の値で変える値を書き換えられない）。
    expect(supplied(changed, { ...SUPPLIED, checkboxPairs: [{ name: 'published', offValue: '0', checkedValue: null }] })).toBeNull();
  });

  const REJECTED: readonly (readonly [string, () => WritePayloadExpectation, unknown])[] = [
    // 鍵の集合（足す・減らす・違う集合）
    ['a kept field added', () => deferredOf(), { ...SUPPLIED, keptFields: [...SUPPLIED.keptFields, { name: 'role', value: 'admin' }] }],
    ['a kept field removed', () => deferredOf(), { ...SUPPLIED, keptFields: [] }],
    ['another kept field', () => deferredOf(), { ...SUPPLIED, keptFields: [{ name: 'role', value: KEPT_MEMO }] }],
    ['a kept field twice', () => deferredOf(), { ...SUPPLIED, keptFields: [...SUPPLIED.keptFields, ...SUPPLIED.keptFields] }],
    ['a checked hidden added', () => deferredOf(), { ...SUPPLIED, checkedPassthroughFields: [...SUPPLIED.checkedPassthroughFields, { name: 'deleted', value: '1' }] }],
    ['a checked hidden removed', () => deferredOf(), { ...SUPPLIED, checkedPassthroughFields: [] }],
    ['another checked hidden', () => deferredOf(), { ...SUPPLIED, checkedPassthroughFields: [{ name: 'deleted', value: 'active' }] }],
    ['a pair added', () => deferredOf(), { ...SUPPLIED, checkboxPairs: [...SUPPLIED.checkboxPairs, { name: 'archived', offValue: '0', checkedValue: null }] }],
    ['a pair removed', () => deferredOf(), { ...SUPPLIED, checkboxPairs: [] }],
    ['a kept field moved to the checked hidden', () => deferredOf(), { ...SUPPLIED, keptFields: [], checkedPassthroughFields: [...SUPPLIED.checkedPassthroughFields, { name: 'memo', value: KEPT_MEMO }] }],
    // 値の形（今の決まりと同じ）
    ['a kept value that is a number', () => deferredOf(), { ...SUPPLIED, keptFields: [{ name: 'memo', value: 1 }] }],
    ['a kept value with a lone surrogate', () => deferredOf(), { ...SUPPLIED, keptFields: [{ name: 'memo', value: String.fromCharCode(0xd800) }] }],
    ['a checked hidden value that is an object', () => deferredOf(), { ...SUPPLIED, checkedPassthroughFields: [{ name: 'status', value: { a: 1 } }] }],
    ['a pair off value that is null', () => deferredOf(), { ...SUPPLIED, checkboxPairs: [{ name: 'published', offValue: null, checkedValue: '1' }] }],
    ['a kept field without the value', () => deferredOf(), { ...SUPPLIED, keptFields: [{ name: 'memo' }] }],
    ['kept fields that are not a list', () => deferredOf(), { ...SUPPLIED, keptFields: { memo: KEPT_MEMO } }],
    ['pairs that are missing', () => deferredOf(), { keptFields: SUPPLIED.keptFields, checkedPassthroughFields: SUPPLIED.checkedPassthroughFields }],
    ['not an object', () => deferredOf(), null],
    // 印と期待
    ['an expectation without the mark', () => expectationOf(enctype, { submittedFields: [{ name: 'customer_name', value: NEW_NAME }], checkedPassthroughFields: undefined, checkboxPairs: undefined }), SUPPLIED],
    ['a mark with checked hidden fields already', () => deferredOf({ checkedPassthroughFields: [{ name: 'status', value: 'active' }] }), SUPPLIED],
    ['a mark with pairs already', () => deferredOf({ checkboxPairs: [{ name: 'published', offValue: '0', checkedValue: '1' }] }), SUPPLIED],
    ['a mark whose names are not a list', () => deferredOf({ deferredPriorValues: markOf({ keptFieldNames: 'memo' as unknown as string[] }) }), SUPPLIED],
    ['a mark with a name twice across the lists', () => deferredOf({ deferredPriorValues: markOf({ checkedPassthroughNames: ['status', 'memo'] }) }), SUPPLIED],
    ['a mark with an empty name', () => deferredOf({ deferredPriorValues: markOf({ keptFieldNames: [''] }) }), { ...SUPPLIED, keptFields: [{ name: '', value: 'x' }] }],
    ['a mark with a changed field name as a kept field', () => deferredOf({ deferredPriorValues: markOf({ keptFieldNames: ['customer_name'] }) }), { ...SUPPLIED, keptFields: [{ name: 'customer_name', value: 'x' }] }],
    ['a mark with the method override name', () => deferredOf({ deferredPriorValues: markOf({ checkedPassthroughNames: ['_method'] }) }), { ...SUPPLIED, checkedPassthroughFields: [{ name: '_method', value: 'DELETE' }] }],
  ];

  it.each(REJECTED)('rejects %s, and the expectation stays blocked', (_label, expectationOfRow, prior) => {
    const expectation = expectationOfRow();
    expect(supplied(expectation, prior)).toBeNull();
    if (expectation.deferredPriorValues !== undefined) {
      expect(check(expectation, bodyFacts(enctype, VALID_PAIRS))).toBe('EXPECTATION_INVALID');
    }
  });

  it('copies the supplied values by index, once each (the original changed later, a replaced map and a getter do not change the result)', () => {
    const keptFields = [{ name: 'memo', value: KEPT_MEMO }];
    const expectation = supplied(deferredOf(), { ...SUPPLIED, keptFields });
    if (expectation === null) throw new Error('not supplied');
    keptFields[0] = { name: 'memo', value: '書き換え' };
    expect(check(expectation, bodyFacts(enctype, VALID_PAIRS))).toBe('ALLOW');
    // `map` を差し替えた一覧（Proxy）と、読むたびに変わる値の getter。
    const proxied = new Proxy([{ name: 'memo', value: KEPT_MEMO }], {
      get: (target, key, receiver) => (key === 'map' ? () => [{ name: 'memo', value: '書き換え' }] : Reflect.get(target, key, receiver)),
    });
    let reads = 0;
    const getter = { name: 'status', get value(): string { reads += 1; return reads === 1 ? 'active' : 'deleted'; } };
    const tricky = supplied(deferredOf(), { ...SUPPLIED, keptFields: proxied, checkedPassthroughFields: [getter] });
    if (tricky === null) throw new Error('not supplied');
    expect(reads).toBe(1);
    expect(check(tricky, bodyFacts(enctype, VALID_PAIRS))).toBe('ALLOW');
    expect(Object.isFrozen(tricky.submittedFields)).toBe(true);
  });

  it('does not throw on any input', () => {
    const hostile = new Proxy({}, { get: () => { throw new Error('hostile'); } });
    expect(supplied(deferredOf(), hostile)).toBeNull();
    expect(supplied(hostile as WritePayloadExpectation)).toBeNull();
    expect(supplied(null as unknown as WritePayloadExpectation)).toBeNull();
  });
});
