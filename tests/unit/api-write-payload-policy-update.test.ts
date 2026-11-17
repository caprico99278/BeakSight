// T41c（Task 41 の設計書 `2026-10-18-beaksight-task-41-api-update-design.md` 3.3、8 章のユーザーの判断 1・2）: 書き込みの段の、API の更新（UPDATE）の照合
// （`src/safety/api-write-payload-policy.ts` の `checkApiWritePayload`）。純粋な関数を表で確かめる。
// - 保つ鍵（`keptKeys`）: 本文にあれば前の値と完全一致を求め、なければ通す（判断 1）。変える鍵・ページが決める鍵と重なる期待は拒む。
// - ページが決める鍵（UPDATE）: 前の値（`pageKeyPriorValues`）と完全一致を求める。前の値のない鍵は期待の誤り（判断 2）。値は結果に返さない（前の値を
//   記録に残さない）。CREATE の扱い（照らさずに通し、値を返す）は変えない。
// - 状態の語の鍵: 承認の鍵の集合の外で本文に現れたら、理由を分けて止める（`BODY_STATE_KEY_UNEXPECTED`。重ねの守り）。
// - filter: UPDATE の filter の値は `eq.<対象の ID>` と完全一致（回帰）。
// - 結果に、生成した値・前の値・ヘッダの値を残さない。どの入力でも投げない。
import { describe, expect, it } from 'vitest';
import {
  apiWriteCheckPathOf,
  apiWriteExpectationWithPriorValues,
  apiWritePriorValuesCopyOf,
  checkApiWritePayload,
  type ApiWritePayloadExpectation,
  type ApiWritePriorValue,
  type ApiWriteRequestFacts,
  type ApiWriteSuppliedPriorValues,
} from '../../src/safety/api-write-payload-policy.js';

const API_ORIGIN = 'https://api.example.test';
const API_PATH = '/rest/v1/members';
const RECORD_ID = '1001';
/** 生成した値（結果に出てはいけない）。 */
const NEW_NAME = 'leak-marker-new 山田';
/** 前の値（結果に出てはいけない）。 */
const PRIOR_EMAIL = 'leak-marker-prior@example.test';
const PRIOR_PLAN = 'leak-marker-plan';
const PRIOR_AGE = 42;

const KEPT: readonly ApiWritePriorValue[] = Object.freeze([
  { key: 'email', value: PRIOR_EMAIL },
  { key: 'age', value: PRIOR_AGE },
  { key: 'newsletter', value: true },
  { key: 'memo', value: null },
]);
const PAGE_PRIORS: readonly ApiWritePriorValue[] = Object.freeze([{ key: 'plan', value: PRIOR_PLAN }]);

const updateExpectation = (overrides: Partial<ApiWritePayloadExpectation> = {}): ApiWritePayloadExpectation => ({
  spec: {
    request: { method: 'PATCH', origin: API_ORIGIN, pathShape: API_PATH, queryNames: ['select'], contentType: 'application/json', prefer: ['return=representation'] },
    keyFields: [{ key: 'name', type: 'string' }],
    pageKeys: [{ key: 'plan', type: 'string' }],
    headerNames: ['authorization', 'content-type', 'prefer'],
    filterName: 'id',
  },
  values: { name: NEW_NAME },
  recordId: RECORD_ID,
  keptKeys: KEPT,
  pageKeyPriorValues: PAGE_PRIORS,
  ...overrides,
});

const createExpectation = (overrides: Partial<ApiWritePayloadExpectation> = {}): ApiWritePayloadExpectation => {
  const update = updateExpectation();
  return {
    spec: { ...update.spec, request: { ...update.spec.request, method: 'POST' }, filterName: null },
    values: update.values,
    recordId: null,
    ...overrides,
  };
};

const HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
  Authorization: 'Bearer leak-marker-bearer',
  Accept: '*/*',
  Origin: 'https://app.example.test',
});

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
const FULL_BODY = { name: NEW_NAME, email: PRIOR_EMAIL, age: PRIOR_AGE, newsletter: true, memo: null, plan: PRIOR_PLAN };

const updateFacts = (body: Record<string, unknown> | string = FULL_BODY, url = `${API_ORIGIN}${API_PATH}?id=eq.${RECORD_ID}&select=*`): ApiWriteRequestFacts => ({
  method: 'PATCH',
  url,
  headers: HEADERS,
  body: bytesOf(typeof body === 'string' ? body : JSON.stringify(body)),
});

const createFacts = (body: Record<string, unknown> = { name: NEW_NAME, plan: 'any-plan' }): ApiWriteRequestFacts => ({
  method: 'POST',
  url: `${API_ORIGIN}${API_PATH}?select=*`,
  headers: HEADERS,
  body: bytesOf(JSON.stringify(body)),
});

/** 結果に、生成した値・前の値・ヘッダの値が出ていないこと。 */
const expectNoLeak = (result: unknown): void => {
  const text = JSON.stringify(result);
  expect(text).not.toContain('leak-marker');
  expect(text).not.toContain(String(PRIOR_AGE));
};

describe('T41c: the API UPDATE check admits the approved forms', () => {
  it('admits the body with the changed key, every kept key at its prior value, and the page key at its prior value, and returns no value', () => {
    const result = checkApiWritePayload(updateExpectation(), updateFacts());
    expect(result).toEqual({ decision: 'ALLOW', pageKeyValues: {} });
    expectNoLeak(result);
  });

  it.each<[string, Record<string, unknown> | string]>([
    ['no kept key in the body (judgement 1)', { name: NEW_NAME, plan: PRIOR_PLAN }],
    ['some kept keys in the body', { name: NEW_NAME, email: PRIOR_EMAIL, plan: PRIOR_PLAN }],
    ['the kept keys in another order', { plan: PRIOR_PLAN, memo: null, newsletter: true, age: PRIOR_AGE, email: PRIOR_EMAIL, name: NEW_NAME }],
    ['a kept string escaped differently', `{"name":${JSON.stringify(NEW_NAME)},"email":"leak-marker-prior\\u0040example.test","plan":"${PRIOR_PLAN}"}`],
  ])('admits %s', (_label, body) => {
    const result = checkApiWritePayload(updateExpectation(), updateFacts(body));
    expect(result).toEqual({ decision: 'ALLOW', pageKeyValues: {} });
    expectNoLeak(result);
  });

  it('admits an UPDATE without kept keys and page keys (the fields not given are none)', () => {
    const expectation = updateExpectation({
      spec: { ...updateExpectation().spec, pageKeys: [] },
      keptKeys: undefined,
      pageKeyPriorValues: undefined,
    });
    expect(checkApiWritePayload(expectation, updateFacts({ name: NEW_NAME })).decision).toBe('ALLOW');
    // 保つ鍵を渡さなければ、その鍵は承認の外（止まる。fail-closed）。
    expect(checkApiWritePayload(expectation, updateFacts({ name: NEW_NAME, email: PRIOR_EMAIL })).decision).toBe('BODY_KEY_UNEXPECTED');
  });

  it('keeps the CREATE as it was: the page key is not compared and its value is returned', () => {
    const result = checkApiWritePayload(createExpectation(), createFacts());
    expect(result).toEqual({ decision: 'ALLOW', pageKeyValues: { plan: 'any-plan' } });
  });
});

/** 表の 1 行: 名前、期待、要求の事実、理由。 */
type BlockRow = readonly [string, ApiWritePayloadExpectation, ApiWriteRequestFacts, string];

const BLOCKED: readonly BlockRow[] = [
  // 保つ鍵
  ['a kept string changed', updateExpectation(), updateFacts({ ...FULL_BODY, email: 'other@example.test' }), 'BODY_VALUE_MISMATCH'],
  ['a kept number changed', updateExpectation(), updateFacts({ ...FULL_BODY, age: 43 }), 'BODY_VALUE_MISMATCH'],
  ['a kept number written as 42.0', updateExpectation(), updateFacts(JSON.stringify(FULL_BODY).replace('"age":42', '"age":42.0')), 'BODY_VALUE_MISMATCH'],
  ['a kept number as a string', updateExpectation(), updateFacts({ ...FULL_BODY, age: '42' }), 'BODY_VALUE_TYPE_MISMATCH'],
  ['a kept boolean changed', updateExpectation(), updateFacts({ ...FULL_BODY, newsletter: false }), 'BODY_VALUE_MISMATCH'],
  ['a kept null filled', updateExpectation(), updateFacts({ ...FULL_BODY, memo: '' }), 'BODY_VALUE_TYPE_MISMATCH'],
  ['a kept string emptied', updateExpectation(), updateFacts({ ...FULL_BODY, email: '' }), 'BODY_VALUE_MISMATCH'],
  ['a kept string set to null', updateExpectation(), updateFacts({ ...FULL_BODY, email: null }), 'BODY_VALUE_TYPE_MISMATCH'],
  ['a kept key with a nested value', updateExpectation(), updateFacts({ ...FULL_BODY, email: { a: 1 } }), 'BODY_VALUE_NOT_SCALAR'],
  ['a kept key twice', updateExpectation(), updateFacts(`{"name":${JSON.stringify(NEW_NAME)},"email":"x","email":"${PRIOR_EMAIL}","plan":"${PRIOR_PLAN}"}`), 'BODY_DUPLICATE_KEY'],
  // 変える鍵（今の照合）
  ['the changed key rewritten', updateExpectation(), updateFacts({ ...FULL_BODY, name: 'rewritten' }), 'BODY_VALUE_MISMATCH'],
  ['the changed key missing', updateExpectation(), updateFacts({ email: PRIOR_EMAIL, plan: PRIOR_PLAN }), 'BODY_KEY_MISSING'],
  // ページが決める鍵（判断 2）
  ['the page key changed', updateExpectation(), updateFacts({ ...FULL_BODY, plan: 'platinum' }), 'BODY_VALUE_MISMATCH'],
  ['the page key of another type', updateExpectation(), updateFacts({ ...FULL_BODY, plan: 1 }), 'BODY_VALUE_TYPE_MISMATCH'],
  ['the page key missing', updateExpectation(), updateFacts({ name: NEW_NAME }), 'BODY_KEY_MISSING'],
  // 承認の外の鍵
  ['a state word key outside the approval (deleted)', updateExpectation(), updateFacts({ ...FULL_BODY, deleted: true }), 'BODY_STATE_KEY_UNEXPECTED'],
  ['a state word key outside the approval (is_active)', updateExpectation(), updateFacts({ ...FULL_BODY, is_active: false }), 'BODY_STATE_KEY_UNEXPECTED'],
  ['a state word key outside the approval (camelCase deletedAt)', updateExpectation(), updateFacts({ ...FULL_BODY, deletedAt: '2026-10-18' }), 'BODY_STATE_KEY_UNEXPECTED'],
  ['a state word key outside the approval on a CREATE', createExpectation(), createFacts({ name: NEW_NAME, plan: 'p', status: 'archived' }), 'BODY_STATE_KEY_UNEXPECTED'],
  ['another key outside the approval', updateExpectation(), updateFacts({ ...FULL_BODY, role: 'admin' }), 'BODY_KEY_UNEXPECTED'],
  // filter（回帰）
  ['the filter value of another id', updateExpectation(), updateFacts(FULL_BODY, `${API_ORIGIN}${API_PATH}?id=eq.1002&select=*`), 'FILTER_MISMATCH'],
  ['the filter value with a leading zero', updateExpectation(), updateFacts(FULL_BODY, `${API_ORIGIN}${API_PATH}?id=eq.0${RECORD_ID}&select=*`), 'FILTER_MISMATCH'],
  ['the filter value with a plus (a space)', updateExpectation(), updateFacts(FULL_BODY, `${API_ORIGIN}${API_PATH}?id=eq.${RECORD_ID}+&select=*`), 'FILTER_MISMATCH'],
  ['the filter value with another condition after a semicolon', updateExpectation(), updateFacts(FULL_BODY, `${API_ORIGIN}${API_PATH}?id=eq.${RECORD_ID};id=neq.0&select=*`), 'FILTER_MISMATCH'],
  ['the neq operator', updateExpectation(), updateFacts(FULL_BODY, `${API_ORIGIN}${API_PATH}?id=neq.${RECORD_ID}&select=*`), 'FILTER_MISMATCH'],
  ['the filter twice', updateExpectation(), updateFacts(FULL_BODY, `${API_ORIGIN}${API_PATH}?id=eq.${RECORD_ID}&id=eq.${RECORD_ID}&select=*`), 'QUERY_MISMATCH'],
  ['no filter', updateExpectation(), updateFacts(FULL_BODY, `${API_ORIGIN}${API_PATH}?select=*`), 'QUERY_MISMATCH'],
  ['another filter name', updateExpectation(), updateFacts(FULL_BODY, `${API_ORIGIN}${API_PATH}?uid=eq.${RECORD_ID}&select=*`), 'QUERY_MISMATCH'],
  // 期待の誤り（fail-closed）
  ['a kept key that is also a changed key', updateExpectation({ keptKeys: [...KEPT, { key: 'name', value: 'x' }] }), updateFacts(), 'EXPECTATION_INVALID'],
  ['a kept key that is also a page key', updateExpectation({ keptKeys: [...KEPT, { key: 'plan', value: PRIOR_PLAN }] }), updateFacts(), 'EXPECTATION_INVALID'],
  ['a kept key twice', updateExpectation({ keptKeys: [...KEPT, { key: 'email', value: PRIOR_EMAIL }] }), updateFacts(), 'EXPECTATION_INVALID'],
  ['a kept key with an empty name', updateExpectation({ keptKeys: [{ key: '', value: 'x' }] }), updateFacts({ name: NEW_NAME, plan: PRIOR_PLAN }), 'EXPECTATION_INVALID'],
  ['a kept key of the method override', updateExpectation({ keptKeys: [{ key: '_method', value: 'PATCH' }] }), updateFacts({ name: NEW_NAME, plan: PRIOR_PLAN }), 'EXPECTATION_INVALID'],
  ['a kept value that is an object', updateExpectation({ keptKeys: [{ key: 'email', value: { a: 1 } as unknown as string }] }), updateFacts({ name: NEW_NAME, plan: PRIOR_PLAN }), 'EXPECTATION_INVALID'],
  ['a kept value that is not finite', updateExpectation({ keptKeys: [{ key: 'age', value: Number.NaN }] }), updateFacts({ name: NEW_NAME, plan: PRIOR_PLAN }), 'EXPECTATION_INVALID'],
  ['a kept value that is undefined', updateExpectation({ keptKeys: [{ key: 'age', value: undefined as unknown as null }] }), updateFacts({ name: NEW_NAME, plan: PRIOR_PLAN }), 'EXPECTATION_INVALID'],
  ['kept keys that are not a list', updateExpectation({ keptKeys: { email: PRIOR_EMAIL } as unknown as ApiWritePriorValue[] }), updateFacts({ name: NEW_NAME, plan: PRIOR_PLAN }), 'EXPECTATION_INVALID'],
  ['a page key without a prior value on an UPDATE (judgement 2)', updateExpectation({ pageKeyPriorValues: [] }), updateFacts(), 'EXPECTATION_INVALID'],
  ['page keys without prior values on an UPDATE', updateExpectation({ pageKeyPriorValues: undefined }), updateFacts(), 'EXPECTATION_INVALID'],
  ['a prior value of a key that is not a page key', updateExpectation({ pageKeyPriorValues: [...PAGE_PRIORS, { key: 'tier', value: 'x' }] }), updateFacts(), 'EXPECTATION_INVALID'],
  ['a page key prior value twice', updateExpectation({ pageKeyPriorValues: [...PAGE_PRIORS, ...PAGE_PRIORS] }), updateFacts(), 'EXPECTATION_INVALID'],
  ['a page key prior value of another type', updateExpectation({ pageKeyPriorValues: [{ key: 'plan', value: 1 }] }), updateFacts(), 'EXPECTATION_INVALID'],
  ['kept keys on a CREATE', createExpectation({ keptKeys: KEPT }), createFacts(), 'EXPECTATION_INVALID'],
  ['page key prior values on a CREATE', createExpectation({ pageKeyPriorValues: PAGE_PRIORS }), createFacts(), 'EXPECTATION_INVALID'],
];

describe('T41c: the API UPDATE check blocks with a closed reason and no value', () => {
  it.each(BLOCKED)('blocks %s', (_label, expectation, facts, reason) => {
    const result = checkApiWritePayload(expectation, facts);
    expect(result).toEqual({ decision: reason });
    expectNoLeak(result);
  });

  it('admits the encoded forms of the filter that the server reads as the same value (the URL decoding of the query)', () => {
    for (const query of [`id=eq%2E${RECORD_ID}&select=*`, `%69d=eq.${RECORD_ID}&select=*`, `select=*&id=eq.${RECORD_ID}`]) {
      expect(checkApiWritePayload(updateExpectation(), updateFacts(FULL_BODY, `${API_ORIGIN}${API_PATH}?${query}`)).decision).toBe('ALLOW');
    }
  });
});

// LU-5（設計書 `2026-11-02-beaksight-list-row-update-design.md` 4.0 の D1、5.3 の 1・3）: path に番号が入る形の更新（filter のない UPDATE）。期待の path の
// 型の最後の区切りが `{id}`（ちょうど 1 つ）のときだけ受け、`{id}` を台帳の番号にした具体的な path で完全一致を行う。query の名前の集合と本文の照合は今のまま。
describe('LU-5: the API UPDATE check of the path shape that ends with the record id', () => {
  const PATH_TEMPLATE = '/api/items/{id}';
  const PATH_RECORD_ID = '4';
  const pathExpectation = (overrides: Partial<ApiWritePayloadExpectation> = {}, pathShape = PATH_TEMPLATE, queryNames: readonly string[] = []): ApiWritePayloadExpectation => {
    const base = updateExpectation();
    return {
      ...base,
      spec: { ...base.spec, request: { ...base.spec.request, pathShape, queryNames }, filterName: null },
      recordId: PATH_RECORD_ID,
      ...overrides,
    };
  };
  const pathFacts = (path: string, body: Record<string, unknown> = FULL_BODY, method = 'PATCH'): ApiWriteRequestFacts => ({
    method,
    url: `${API_ORIGIN}${path}`,
    headers: HEADERS,
    body: bytesOf(JSON.stringify(body)),
  });

  it('admits the PATCH to the concrete path of the record id and returns no prior value', () => {
    const result = checkApiWritePayload(pathExpectation(), pathFacts('/api/items/4'));
    expect(result).toEqual({ decision: 'ALLOW', pageKeyValues: {} });
    expectNoLeak(result);
  });

  it('admits the approved select query on the path shape', () => {
    expect(checkApiWritePayload(pathExpectation({}, PATH_TEMPLATE, ['select']), pathFacts('/api/items/4?select=*')).decision).toBe('ALLOW');
  });

  const PATH_BLOCKED: readonly (readonly [string, ApiWritePayloadExpectation, ApiWriteRequestFacts, string])[] = [
    ['another record id', pathExpectation(), pathFacts('/api/items/5'), 'ENDPOINT_MISMATCH'],
    ['a path under the record', pathExpectation(), pathFacts('/api/items/4/x'), 'ENDPOINT_MISMATCH'],
    ['the collection path', pathExpectation(), pathFacts('/api/items'), 'ENDPOINT_MISMATCH'],
    ['the record id with a leading zero', pathExpectation(), pathFacts('/api/items/04'), 'ENDPOINT_MISMATCH'],
    ['the literal template', pathExpectation(), pathFacts('/api/items/%7Bid%7D'), 'ENDPOINT_MISMATCH'],
    ['a filter query on the path shape', pathExpectation(), pathFacts('/api/items/4?id=eq.4'), 'QUERY_MISMATCH'],
    ['a missing approved query', pathExpectation({}, PATH_TEMPLATE, ['select']), pathFacts('/api/items/4'), 'QUERY_MISMATCH'],
    ['another method', pathExpectation(), pathFacts('/api/items/4', FULL_BODY, 'DELETE'), 'METHOD_MISMATCH'],
    ['a changed kept value', pathExpectation(), pathFacts('/api/items/4', { ...FULL_BODY, email: 'other@example.test' }), 'BODY_VALUE_MISMATCH'],
    ['a changed page key value', pathExpectation(), pathFacts('/api/items/4', { ...FULL_BODY, plan: 'other' }), 'BODY_VALUE_MISMATCH'],
    ['another changed value', pathExpectation(), pathFacts('/api/items/4', { ...FULL_BODY, name: 'other' }), 'BODY_VALUE_MISMATCH'],
    ['a key outside the approval', pathExpectation(), pathFacts('/api/items/4', { ...FULL_BODY, role: 'admin' }), 'BODY_KEY_UNEXPECTED'],
    // 期待の誤り（fail-closed。5.3 の 1）
    ['both the filter and the record id segment', pathExpectation({ spec: { ...pathExpectation().spec, filterName: 'id' } }), pathFacts('/api/items/4?id=eq.4'), 'EXPECTATION_INVALID'],
    ['two record id segments', pathExpectation({}, '/api/{id}/items/{id}'), pathFacts('/api/4/items/4'), 'EXPECTATION_INVALID'],
    ['a record id segment that is not the last', pathExpectation({}, '/api/items/{id}/edit'), pathFacts('/api/items/4/edit'), 'EXPECTATION_INVALID'],
    ['a record id inside a segment', pathExpectation({}, '/api/items/x{id}'), pathFacts('/api/items/x4'), 'EXPECTATION_INVALID'],
    ['neither the filter nor the record id segment', pathExpectation({}, '/api/items'), pathFacts('/api/items'), 'EXPECTATION_INVALID'],
    ['no record id', pathExpectation({ recordId: null }), pathFacts('/api/items/4'), 'EXPECTATION_INVALID'],
    ['an empty record id', pathExpectation({ recordId: '' }), pathFacts('/api/items/'), 'EXPECTATION_INVALID'],
    // L12b（設計書 `2026-11-09-beaksight-remove-limits-design.md` 6.2。設計者の判断 1・2）: 登録の ID の長さの上限は撤廃したので、長すぎる例は外した
    // （使える文字の決まりだけで止める）。
    ...(['4/x', '4?x=1', '4#x', '%34', '.', '..', '4.5', '4~5', '4 5', '4;x', 'あ'] as const).map((recordId) =>
      [`a record id that is not one path segment (${recordId})`, pathExpectation({ recordId }), pathFacts('/api/items/4'), 'EXPECTATION_INVALID'] as const),
  ];

  it.each(PATH_BLOCKED)('blocks %s', (_label, expectation, facts, reason) => {
    const result = checkApiWritePayload(expectation, facts);
    expect(result).toEqual({ decision: reason });
    expectNoLeak(result);
  });

  it('admits a record id of the usable shape (letters, digits, underscore, hyphen, up to 64 characters)', () => {
    for (const recordId of ['a_B-9', '9'.repeat(64)]) {
      expect(checkApiWritePayload(pathExpectation({ recordId }), pathFacts(`/api/items/${recordId}`)).decision).toBe('ALLOW');
    }
  });

  // fix round 1（案 A）: 照合へ回す要求の path の唯一の部品。path の形の更新は具体的な path、ほかは型のまま。作れない期待は null。
  it('gives the path that the request decision compares with (apiWriteCheckPathOf)', () => {
    expect(apiWriteCheckPathOf(pathExpectation())).toBe('/api/items/4');
    expect(apiWriteCheckPathOf(updateExpectation())).toBe(API_PATH);
    expect(apiWriteCheckPathOf(createExpectation())).toBe(API_PATH);
    expect(apiWriteCheckPathOf(pathExpectation({}, '/api/items/{id}/edit'))).toBeNull();
    expect(apiWriteCheckPathOf(pathExpectation({ recordId: '4/x' }))).toBeNull();
    expect(apiWriteCheckPathOf(pathExpectation({ spec: { ...pathExpectation().spec, filterName: 'id' } }))).toBeNull();
    expect(apiWriteCheckPathOf(null as unknown as ApiWritePayloadExpectation)).toBeNull();
  });

  it('keeps the filter UPDATE unchanged (a filter UPDATE on a path without the record id segment)', () => {
    expect(checkApiWritePayload(updateExpectation(), updateFacts()).decision).toBe('ALLOW');
    expect(checkApiWritePayload(updateExpectation(), updateFacts(FULL_BODY, `${API_ORIGIN}${API_PATH}/${RECORD_ID}?id=eq.${RECORD_ID}&select=*`)).decision)
      .toBe('ENDPOINT_MISMATCH');
  });
});

// LU-9（設計書 `2026-11-02-beaksight-list-row-update-design.md` 4.0.1 の K1、5.3 の 2）: 前の値を後から入れる印（`deferredPriorValues`）のある期待。印の
// ある期待は、前の値を入れるまで照合が `EXPECTATION_INVALID` で止める（fail-closed）。入れられるのは値だけで、鍵の集合（保つ鍵は印の名前、ページが決める鍵は
// 承認の鍵）は期待を作る時に決まっている。値の形は、今の `keptKeys`・`pageKeyPriorValues` と同じ決まり（`acceptedExpectationOf`）で確かめる。
describe('LU-9: the API UPDATE expectation whose prior values are supplied later', () => {
  const deferredExpectation = (overrides: Partial<ApiWritePayloadExpectation> = {}): ApiWritePayloadExpectation => updateExpectation({
    keptKeys: undefined,
    pageKeyPriorValues: undefined,
    deferredPriorValues: { keptKeys: KEPT.map(({ key }) => key) },
    ...overrides,
  });
  const SUPPLIED: ApiWriteSuppliedPriorValues = Object.freeze({ keptKeys: KEPT, pageKeyPriorValues: PAGE_PRIORS });

  it('blocks every request with EXPECTATION_INVALID before the prior values are supplied (fail-closed)', () => {
    for (const facts of [updateFacts(), updateFacts({ name: NEW_NAME, plan: PRIOR_PLAN })]) {
      expect(checkApiWritePayload(deferredExpectation(), facts)).toEqual({ decision: 'EXPECTATION_INVALID' });
    }
  });

  it('admits the body that matches the supplied prior values, and blocks a changed kept value with the current reason', () => {
    const supplied = apiWriteExpectationWithPriorValues(deferredExpectation(), SUPPLIED);
    expect(supplied).not.toBeNull();
    if (supplied === null) return;
    expect(supplied.deferredPriorValues).toBeUndefined();
    const result = checkApiWritePayload(supplied, updateFacts());
    expect(result).toEqual({ decision: 'ALLOW', pageKeyValues: {} });
    expectNoLeak(result);
    expect(checkApiWritePayload(supplied, updateFacts({ ...FULL_BODY, email: 'other@example.test' }))).toEqual({ decision: 'BODY_VALUE_MISMATCH' });
    expect(checkApiWritePayload(supplied, updateFacts({ ...FULL_BODY, plan: 'platinum' }))).toEqual({ decision: 'BODY_VALUE_MISMATCH' });
    expect(checkApiWritePayload(supplied, updateFacts({ ...FULL_BODY, age: '42' }))).toEqual({ decision: 'BODY_VALUE_TYPE_MISMATCH' });
    // 元の期待は変わらない（印のまま。純粋）。
    expect(checkApiWritePayload(deferredExpectation(), updateFacts())).toEqual({ decision: 'EXPECTATION_INVALID' });
  });

  it('admits the supplied kept keys in another order', () => {
    const supplied = apiWriteExpectationWithPriorValues(deferredExpectation(), { ...SUPPLIED, keptKeys: [...KEPT].reverse() });
    expect(supplied === null ? null : checkApiWritePayload(supplied, updateFacts()).decision).toBe('ALLOW');
  });

  it('admits an empty kept key set and no page key when the approval has none', () => {
    const expectation = deferredExpectation({ spec: { ...updateExpectation().spec, pageKeys: [] }, deferredPriorValues: { keptKeys: [] } });
    const supplied = apiWriteExpectationWithPriorValues(expectation, { keptKeys: [], pageKeyPriorValues: [] });
    expect(supplied === null ? null : checkApiWritePayload(supplied, updateFacts({ name: NEW_NAME })).decision).toBe('ALLOW');
  });

  const REJECTED: readonly (readonly [string, ApiWritePayloadExpectation, unknown])[] = [
    // 鍵の集合（足す・減らす・違う集合）
    ['a kept key added', deferredExpectation(), { ...SUPPLIED, keptKeys: [...KEPT, { key: 'role', value: 'x' }] }],
    ['a kept key removed', deferredExpectation(), { ...SUPPLIED, keptKeys: KEPT.slice(1) }],
    ['another kept key set', deferredExpectation(), { ...SUPPLIED, keptKeys: [...KEPT.slice(1), { key: 'role', value: PRIOR_EMAIL }] }],
    ['a kept key twice', deferredExpectation(), { ...SUPPLIED, keptKeys: [...KEPT, KEPT[0]] }],
    ['a page key prior value added', deferredExpectation(), { ...SUPPLIED, pageKeyPriorValues: [...PAGE_PRIORS, { key: 'tier', value: 'x' }] }],
    ['a page key prior value removed', deferredExpectation(), { ...SUPPLIED, pageKeyPriorValues: [] }],
    ['another page key', deferredExpectation(), { ...SUPPLIED, pageKeyPriorValues: [{ key: 'tier', value: PRIOR_PLAN }] }],
    // 値の形（今の決まりと同じ）
    ['a kept value that is an object', deferredExpectation(), { ...SUPPLIED, keptKeys: [{ key: 'email', value: { a: 1 } }, ...KEPT.slice(1)] }],
    ['a kept value that is not finite', deferredExpectation(), { ...SUPPLIED, keptKeys: [...KEPT.slice(0, 1), { key: 'age', value: Number.NaN }, ...KEPT.slice(2)] }],
    ['a kept entry without the value', deferredExpectation(), { ...SUPPLIED, keptKeys: [{ key: 'email' }, ...KEPT.slice(1)] }],
    ['a page key prior value of another type', deferredExpectation(), { ...SUPPLIED, pageKeyPriorValues: [{ key: 'plan', value: 1 }] }],
    ['kept keys that are not a list', deferredExpectation(), { ...SUPPLIED, keptKeys: { email: PRIOR_EMAIL } }],
    ['page key prior values that are missing', deferredExpectation(), { keptKeys: KEPT }],
    ['not an object', deferredExpectation(), null],
    // 印と期待
    ['an expectation without the mark', updateExpectation({ keptKeys: undefined, pageKeyPriorValues: undefined }), SUPPLIED],
    ['an expectation with the mark and kept prior values already', deferredExpectation({ keptKeys: KEPT }), SUPPLIED],
    ['an expectation with the mark and page prior values already', deferredExpectation({ pageKeyPriorValues: PAGE_PRIORS }), SUPPLIED],
    ['a mark whose kept key names are not a list', deferredExpectation({ deferredPriorValues: { keptKeys: 'email' as unknown as string[] } }), SUPPLIED],
    ['a mark with a kept key name twice', deferredExpectation({ deferredPriorValues: { keptKeys: [...KEPT.map(({ key }) => key), 'email'] } }), SUPPLIED],
    ['a mark with an empty kept key name', deferredExpectation({ deferredPriorValues: { keptKeys: [''] } }), { ...SUPPLIED, keptKeys: [{ key: '', value: 'x' }] }],
    ['a mark on a CREATE', createExpectation({ deferredPriorValues: { keptKeys: [] } }), { keptKeys: [], pageKeyPriorValues: [] }],
    ['a kept key that is also a changed key', deferredExpectation({ deferredPriorValues: { keptKeys: ['name'] } }), { ...SUPPLIED, keptKeys: [{ key: 'name', value: 'x' }] }],
  ];

  it.each(REJECTED)('rejects %s, and the expectation stays blocked', (_label, expectation, supplied) => {
    expect(apiWriteExpectationWithPriorValues(expectation, supplied as ApiWriteSuppliedPriorValues)).toBeNull();
    if (expectation.deferredPriorValues !== undefined) {
      expect(checkApiWritePayload(expectation, updateFacts()).decision).toBe('EXPECTATION_INVALID');
    }
  });

  it('does not throw on any input', () => {
    const hostile = new Proxy({}, { get: () => { throw new Error('leak-marker-hostile'); } });
    expect(apiWriteExpectationWithPriorValues(deferredExpectation(), hostile as ApiWriteSuppliedPriorValues)).toBeNull();
    expect(apiWriteExpectationWithPriorValues(hostile as ApiWritePayloadExpectation, SUPPLIED)).toBeNull();
    expect(apiWriteExpectationWithPriorValues(null as unknown as ApiWritePayloadExpectation, SUPPLIED)).toBeNull();
  });

  // LU-SFIX1（LU-SREV1 の Minor-2）: 受けた前の値は、確かめる前に写して凍らせる（getter で後から値が変わっても、確かめた値と照らす値は同じ）。
  it('copies and freezes the supplied prior values before the check, so a getter that changes later does not change the check', () => {
    let reads = 0;
    const flipping = { key: 'email', get value(): string { reads += 1; return reads === 1 ? PRIOR_EMAIL : 'leak-marker-evil@example.test'; } };
    const supplied = apiWriteExpectationWithPriorValues(deferredExpectation(), { ...SUPPLIED, keptKeys: [flipping, ...KEPT.slice(1)] });
    expect(supplied).not.toBeNull();
    if (supplied === null) return;
    expect(reads).toBe(1);
    expect(Object.isFrozen(supplied.keptKeys)).toBe(true);
    expect(supplied.keptKeys?.every((entry) => Object.isFrozen(entry))).toBe(true);
    expect(checkApiWritePayload(supplied, updateFacts()).decision).toBe('ALLOW');
    expect(checkApiWritePayload(supplied, updateFacts({ ...FULL_BODY, email: 'leak-marker-evil@example.test' })).decision).toBe('BODY_VALUE_MISMATCH');
    expect(reads).toBe(1);
  });

  // LU-SFIX1（LU-SREV1 の Minor-1・2）: 一覧の `map` を差し替えた Proxy でも、写しは添字の繰り返しで作る（`map` の返す一覧で鍵の集合の確かめを外せない）。
  it('does not call the map of the supplied list (a Proxy that replaces map cannot hide an extra kept key)', () => {
    const real = [...KEPT, { key: 'role', value: 'admin' }];
    let mapCalls = 0;
    const hijacked = new Proxy(real, {
      get(target, property, receiver) {
        if (property === 'map') {
          // 鍵の名前の確かめに使われれば、印の名前だけ（`role` を隠す）を返す。
          return (copyEntry: (entry: unknown) => unknown) => { mapCalls += 1; return KEPT.map((entry) => copyEntry(entry)); };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    expect(apiWriteExpectationWithPriorValues(deferredExpectation(), { ...SUPPLIED, keptKeys: hijacked })).toBeNull();
    expect(mapCalls).toBe(0);
  });
});

// LU-SFIX1（LU-SREV1 の Minor-1）: 前の値の一覧の唯一の写し方（Guard の期待の写しと前の値の口が使う）。`map` を呼ばず、項目の `key`・`value` は 1 回だけ読む。
describe('LU-SFIX1: the copy of the prior value list', () => {
  it('copies by index without calling map, reads each value once, and freezes the copy', () => {
    let reads = 0;
    const entry = { key: 'note', get value(): string { reads += 1; return reads === 1 ? 'old' : 'leak-marker-evil'; } };
    let mapCalls = 0;
    const hijacked = new Proxy([entry], {
      get(target, property, receiver) {
        if (property === 'map') {
          return () => { mapCalls += 1; return [{ key: 'note', value: 'leak-marker-evil' }]; };
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const copy = apiWritePriorValuesCopyOf(hijacked);
    expect(copy).toEqual([{ key: 'note', value: 'old' }]);
    expect(mapCalls).toBe(0);
    expect(reads).toBe(1);
    expect(Object.isFrozen(copy)).toBe(true);
    expect((copy as readonly object[]).every((item) => Object.isFrozen(item))).toBe(true);
  });

  it('keeps the shapes the check rejects (not a list, a non-scalar value, an entry without the value)', () => {
    expect(apiWritePriorValuesCopyOf({ note: 'old' })).toEqual({});
    expect(apiWritePriorValuesCopyOf([{ key: 'note', value: { a: 1 } }])).toEqual([{ key: 'note', value: {} }]);
    expect(apiWritePriorValuesCopyOf([{ key: 'note' }])).toEqual([{ key: 'note' }]);
    expect(apiWritePriorValuesCopyOf([{ key: 1, value: 'x' }, 'raw'])).toEqual([{ key: null, value: 'x' }, 'raw']);
  });
});
