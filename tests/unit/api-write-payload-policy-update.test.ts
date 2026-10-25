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
  checkApiWritePayload,
  type ApiWritePayloadExpectation,
  type ApiWritePriorValue,
  type ApiWriteRequestFacts,
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
