// T39a（Task 39 の設計書 `2026-10-17-beaksight-task-39-api-write-guard-design.md` 3.2、4 章、5 章の 1）: 書き込みの段の、承認した API の要求の照合
// （`src/safety/api-write-payload-policy.ts` の `checkApiWritePayload`）。純粋な関数を表で確かめる。
// - 一致する形（CREATE の POST、UPDATE の PATCH、ブラウザが付けるヘッダ、`charset=utf-8` の引数、ページが決める鍵）は通し、ページが決める鍵の値だけを返す。
// - 敵対的な形（鍵の追加・削除、値の書き換え、型の違い、filter の書き換え、別の Origin・path、upsert、array・入れ子、method の上書き、許していない
//   ヘッダ、`Content-Type` の違い、大きすぎる本文、壊れた JSON、重複した鍵）は、閉じた一覧の理由で止める。
// - 結果に、生成した値・ページが決める鍵のほかの値・ヘッダの値を残さない。どの入力でも投げない。
// - Guard の要約の理由の鍵（`WRITE_STAGE_PAYLOAD_BLOCK_REASONS`）は、form の照合と API の照合の理由を重ねずに合わせた一覧。
import { describe, expect, it } from 'vitest';
import type { ScenarioApiSpec } from '../../src/control/approval/scenario-contracts.js';
import { MAX_API_REQUEST_BODY_BYTES, apiRequestShapeOf } from '../../src/core/api-request-shape.js';
import {
  API_WRITE_PAYLOAD_BLOCK_REASONS,
  API_WRITE_PAYLOAD_DECISIONS,
  MAX_API_WRITE_BODY_BYTES,
  WRITE_STAGE_PAYLOAD_BLOCK_REASONS,
  checkApiWritePayload,
  type ApiWriteCheckSpec,
  type ApiWritePayloadExpectation,
  type ApiWriteRequestFacts,
} from '../../src/safety/api-write-payload-policy.js';
import { WRITE_PAYLOAD_BLOCK_REASONS } from '../../src/safety/write-payload-policy.js';

const API_ORIGIN = 'https://api.example.test';
const API_PATH = '/rest/v1/members';
/** 生成した値（結果に出てはいけない目印を含む）。 */
const NAME_VALUE = 'leak-marker-name 山田';
const AGE_VALUE = '42';
/** ページが決める鍵の値（ALLOW のときだけ結果に出る）。 */
const TENANT_VALUE = 'leak-marker-tenant';
/** ヘッダの値（結果に出てはいけない）。 */
const SECRET_HEADER_VALUE = 'leak-marker-bearer';
const RECORD_ID = '1001';

/** 照合に渡す指定（シナリオの API の指定の項目。`ApiWriteCheckSpec` に当てはまることを、型の確かめで見る）。 */
type ApiSpecOfCheck = Pick<ScenarioApiSpec, 'request' | 'keyFields' | 'pageKeys' | 'headerNames' | 'filterName'>;
/** 型の確かめ: シナリオの API の指定（control の型）は、照合の指定（safety の構造の型）に当てはまる（形が離れたら typecheck が落ちる）。 */
const asCheckSpec = (spec: ScenarioApiSpec | ApiSpecOfCheck): ApiWriteCheckSpec => spec;

const createSpec = (overrides: Partial<ApiSpecOfCheck> = {}): ApiSpecOfCheck => ({
  request: {
    method: 'POST',
    origin: API_ORIGIN,
    pathShape: API_PATH,
    queryNames: ['select'],
    contentType: 'application/json',
    prefer: ['return=representation'],
  },
  keyFields: [
    { key: 'age', type: 'number', field: { kind: 'NAME', name: 'age' }, fieldType: 'number' },
    { key: 'name', type: 'string', field: { kind: 'NAME', name: 'customer_name' }, fieldType: 'text' },
  ],
  pageKeys: [{ key: 'tenant_id', type: 'string' }],
  headerNames: ['apikey', 'authorization', 'content-type', 'prefer'],
  filterName: null,
  ...overrides,
});

const updateSpec = (): ApiSpecOfCheck => createSpec({
  request: { ...createSpec().request, method: 'PATCH' },
  filterName: 'id',
});

const createExpectation = (overrides: Partial<ApiWritePayloadExpectation> = {}): ApiWritePayloadExpectation => ({
  spec: createSpec(),
  values: { name: NAME_VALUE, age: AGE_VALUE },
  recordId: null,
  ...overrides,
});

/** T41c: UPDATE のページが決める鍵には、前の値（欄から読んだ値）が要る（Task 41 の設計書 3.3、ユーザーの判断 2）。 */
const updateExpectation = (overrides: Partial<ApiWritePayloadExpectation> = {}): ApiWritePayloadExpectation =>
  createExpectation({ spec: updateSpec(), recordId: RECORD_ID, pageKeyPriorValues: [{ key: 'tenant_id', value: TENANT_VALUE }], ...overrides });

/** ブラウザとページが付けるヘッダ（ブラウザが付ける名前は照らさない）。 */
const HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
  apikey: SECRET_HEADER_VALUE,
  Authorization: `Bearer ${SECRET_HEADER_VALUE}`,
  Accept: '*/*',
  'Accept-Language': 'ja',
  Origin: 'https://app.example.test',
  Referer: 'https://app.example.test/members/new',
  'User-Agent': 'Mozilla/5.0',
  'sec-ch-ua': '"Chromium"',
  'Sec-Fetch-Mode': 'cors',
});

const BODY_TEXT = JSON.stringify({ name: NAME_VALUE, age: 42, tenant_id: TENANT_VALUE });
const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

const createFacts = (overrides: Partial<ApiWriteRequestFacts> = {}): ApiWriteRequestFacts => ({
  method: 'POST',
  url: `${API_ORIGIN}${API_PATH}?select=*`,
  headers: HEADERS,
  body: bytesOf(BODY_TEXT),
  ...overrides,
});

const updateFacts = (overrides: Partial<ApiWriteRequestFacts> = {}): ApiWriteRequestFacts => createFacts({
  method: 'PATCH',
  url: `${API_ORIGIN}${API_PATH}?id=eq.${RECORD_ID}&select=*`,
  ...overrides,
});

const withBody = (text: string): Partial<ApiWriteRequestFacts> => ({ body: bytesOf(text) });
const withHeaders = (headers: Readonly<Record<string, string>>): Partial<ApiWriteRequestFacts> => ({ headers });
const withoutHeader = (name: string): Partial<ApiWriteRequestFacts> =>
  withHeaders(Object.fromEntries(Object.entries(HEADERS).filter(([key]) => key !== name)));

/** 結果に、生成した値・ヘッダの値が出ていないこと（ページが決める鍵の値は、ALLOW のときだけ出てよい）。 */
const expectNoLeak = (result: unknown, allowPageValue: boolean): void => {
  const text = JSON.stringify(result);
  expect(text).not.toContain('leak-marker-name');
  expect(text).not.toContain('leak-marker-bearer');
  expect(text).not.toContain(AGE_VALUE);
  if (!allowPageValue) {
    expect(text).not.toContain('leak-marker-tenant');
  }
};

describe('T39a: the closed lists of the API write payload check', () => {
  it('has ALLOW first and the closed list of the block reasons', () => {
    expect(API_WRITE_PAYLOAD_DECISIONS).toEqual([
      'ALLOW',
      'EXPECTATION_INVALID',
      'METHOD_MISMATCH',
      'METHOD_OVERRIDE_PRESENT',
      'ENDPOINT_MISMATCH',
      'QUERY_MISMATCH',
      'FILTER_MISMATCH',
      'HEADER_NOT_ALLOWED',
      'CONTENT_TYPE_MISMATCH',
      'PREFER_MISMATCH',
      'BODY_UNAVAILABLE',
      'BODY_TOO_LARGE',
      'BODY_MALFORMED',
      'BODY_NOT_OBJECT',
      'BODY_DUPLICATE_KEY',
      'BODY_VALUE_NOT_SCALAR',
      'BODY_KEY_MISSING',
      'BODY_KEY_UNEXPECTED',
      'BODY_VALUE_TYPE_MISMATCH',
      'BODY_VALUE_MISMATCH',
      // T41c: 承認の鍵の集合の外の状態の語の鍵（重ねの守り。理由を分けて記録する）。
      'BODY_STATE_KEY_UNEXPECTED',
    ]);
    expect(API_WRITE_PAYLOAD_BLOCK_REASONS).toEqual(API_WRITE_PAYLOAD_DECISIONS.slice(1));
    expect(Object.isFrozen(API_WRITE_PAYLOAD_DECISIONS)).toBe(true);
    expect(MAX_API_WRITE_BODY_BYTES).toBe(65_536);
  });

  it('joins the form reasons and the API reasons once each, the form reasons first, for the Guard summary keys', () => {
    expect(WRITE_STAGE_PAYLOAD_BLOCK_REASONS).toEqual([
      ...WRITE_PAYLOAD_BLOCK_REASONS,
      ...API_WRITE_PAYLOAD_BLOCK_REASONS.filter((reason) => !(WRITE_PAYLOAD_BLOCK_REASONS as readonly string[]).includes(reason)),
    ]);
    expect(new Set(WRITE_STAGE_PAYLOAD_BLOCK_REASONS).size).toBe(WRITE_STAGE_PAYLOAD_BLOCK_REASONS.length);
  });
});

describe('T39a: the matching requests', () => {
  it('takes the API spec of a scenario as the spec of the check (by the structure; the type check fails if they drift apart)', () => {
    expect(asCheckSpec(createSpec()).request.origin).toBe(API_ORIGIN);
  });

  it('admits the approved CREATE and returns only the value of the key decided by the page', () => {
    const result = checkApiWritePayload(createExpectation(), createFacts());
    expect(result).toEqual({ decision: 'ALLOW', pageKeyValues: { tenant_id: TENANT_VALUE } });
    expectNoLeak(result, true);
  });

  it('admits the approved UPDATE with the filter of the ledger id', () => {
    // T41c: UPDATE のページが決める鍵は前の値と照らし、値は返さない（前の値を記録に残さない）。
    expect(checkApiWritePayload(updateExpectation(), updateFacts())).toEqual({ decision: 'ALLOW', pageKeyValues: {} });
  });

  it.each<[string, Partial<ApiWriteRequestFacts>]>([
    ['the keys in another order and white space', withBody(` { "tenant_id" : "${TENANT_VALUE}" ,\n "age": 42, "name": "${NAME_VALUE}" } `)],
    ['a string escaped differently', withBody(`{"name":${JSON.stringify(NAME_VALUE).split('山').join('\\u5c71')},"age":42,"tenant_id":"${TENANT_VALUE}"}`)],
    ['the charset parameter of utf-8', withHeaders({ ...HEADERS, 'Content-Type': 'Application/JSON; charset=UTF-8' })],
    ['only the browser headers besides the approved ones', withoutHeader('apikey')],
  ])('admits %s', (_label, overrides) => {
    expect(checkApiWritePayload(createExpectation(), createFacts(overrides)).decision).toBe('ALLOW');
  });

  it('returns the JSON value of each page key by its type (number, boolean, null)', () => {
    const spec = createSpec({ pageKeys: [{ key: 'flag', type: 'boolean' }, { key: 'note', type: 'null' }, { key: 'rank', type: 'number' }] });
    const body = JSON.stringify({ name: NAME_VALUE, age: 42, flag: true, note: null, rank: 2.5 });
    expect(checkApiWritePayload(createExpectation({ spec }), createFacts(withBody(body)))).toEqual({
      decision: 'ALLOW',
      pageKeyValues: { flag: true, note: null, rank: 2.5 },
    });
  });

  it('compares the number of a key field as the canonical JSON of the generated value', () => {
    const values = { name: NAME_VALUE, age: '-12.5' };
    const body = JSON.stringify({ name: NAME_VALUE, age: -12.5, tenant_id: TENANT_VALUE });
    expect(checkApiWritePayload(createExpectation({ values }), createFacts(withBody(body))).decision).toBe('ALLOW');
  });

  it('admits a path that only contains the letters of the procedure call segment (T39R-fix M-4, control)', () => {
    for (const pathShape of ['/rest/v1/rpcs_log', '/rest/v1/members_rpc']) {
      const expectation = createExpectation({ spec: createSpec({ request: { ...createSpec().request, pathShape } }) });
      expect(checkApiWritePayload(expectation, createFacts({ url: `${API_ORIGIN}${pathShape}?select=*` })).decision).toBe('ALLOW');
    }
  });
});

// T39R-fix（M-5）: 型の作り手（`apiRequestShapeOf`）が記録した `Prefer` と `Content-Type` の媒体の型を承認の期待にすると、同じヘッダの値の要求を
// 照合が通す（読み方が 1 か所）。本文の上限も 1 つ。
describe('T39R-fix (M-5): the shape maker and the check read the headers and the body limit in the one way of the contract', () => {
  const shapeOfHeaders = (headers: Readonly<Record<string, string>>) => apiRequestShapeOf({
    method: 'POST',
    resourceType: 'fetch',
    url: `${API_ORIGIN}${API_PATH}?select=*`,
    origin: { kind: 'APPROVED_API', index: 0 },
    headers,
    body: { kind: 'TEXT', text: BODY_TEXT },
  }, { pagePath: '/members/new', markers: [] });

  it.each(['return=representation', 'Return=Representation', ' return=representation , ', 'return=representation,return=representation', 'return=minimal, return=representation'])(
    'admits the Prefer %j as recorded in the shape',
    (value) => {
      const shape = shapeOfHeaders({ 'content-type': 'application/json', prefer: value });
      const expectation = createExpectation({ spec: createSpec({ request: { ...createSpec().request, prefer: [...shape.prefer] } }) });
      expect(checkApiWritePayload(expectation, createFacts(withHeaders({ ...HEADERS, Prefer: value }))).decision).toBe('ALLOW');
    },
  );

  it.each(['application/json', 'Application/JSON', ' application/json ', 'application/json; charset=utf-8', 'APPLICATION/JSON;charset="UTF-8"'])(
    'admits the Content-Type %j as recorded in the shape',
    (value) => {
      const shape = shapeOfHeaders({ 'content-type': value, prefer: 'return=representation' });
      const expectation = createExpectation({ spec: createSpec({ request: { ...createSpec().request, contentType: shape.contentType } }) });
      expect(checkApiWritePayload(expectation, createFacts(withHeaders({ ...HEADERS, 'Content-Type': value }))).decision).toBe('ALLOW');
    },
  );

  it('has the one body limit of the shape maker and the check', () => {
    expect(MAX_API_WRITE_BODY_BYTES).toBe(MAX_API_REQUEST_BODY_BYTES);
  });
});

/** 表の 1 行: 名前、期待（既定は CREATE）、要求の事実の差、理由。 */
type BlockRow = readonly [string, ApiWritePayloadExpectation, ApiWriteRequestFacts, string];

const body = (value: Record<string, unknown>): string => JSON.stringify(value);
const BASE = { name: NAME_VALUE, age: 42, tenant_id: TENANT_VALUE };

const BLOCKED: readonly BlockRow[] = [
  // method と、その上書き
  ['PUT instead of POST', createExpectation(), createFacts({ method: 'PUT' }), 'METHOD_MISMATCH'],
  ['PATCH for a CREATE', createExpectation(), createFacts({ method: 'PATCH' }), 'METHOD_MISMATCH'],
  ['POST for an UPDATE', updateExpectation(), updateFacts({ method: 'POST' }), 'METHOD_MISMATCH'],
  ['a method override header', createExpectation(), createFacts(withHeaders({ ...HEADERS, 'X-HTTP-Method-Override': 'DELETE' })), 'METHOD_OVERRIDE_PRESENT'],
  ['the x-method-override header', createExpectation(), createFacts(withHeaders({ ...HEADERS, 'x-method-override': 'PUT' })), 'METHOD_OVERRIDE_PRESENT'],
  ['the _method key in the body', createExpectation(), createFacts(withBody(body({ ...BASE, _method: 'DELETE' }))), 'METHOD_OVERRIDE_PRESENT'],
  // Origin と path
  ['another origin', createExpectation(), createFacts({ url: `https://other.example.test${API_PATH}?select=*` }), 'ENDPOINT_MISMATCH'],
  ['another port', createExpectation(), createFacts({ url: `https://api.example.test:8443${API_PATH}?select=*` }), 'ENDPOINT_MISMATCH'],
  ['another path', createExpectation(), createFacts({ url: `${API_ORIGIN}/rest/v1/admins?select=*` }), 'ENDPOINT_MISMATCH'],
  ['a procedure call path', createExpectation(), createFacts({ url: `${API_ORIGIN}/rest/v1/rpc/members` }), 'ENDPOINT_MISMATCH'],
  ['a longer path', createExpectation(), createFacts({ url: `${API_ORIGIN}${API_PATH}/1001` }), 'ENDPOINT_MISMATCH'],
  ['credentials in the URL', createExpectation(), createFacts({ url: `https://user:pass@api.example.test${API_PATH}` }), 'ENDPOINT_MISMATCH'],
  ['an unparsable URL', createExpectation(), createFacts({ url: 'not a url' }), 'ENDPOINT_MISMATCH'],
  // query と filter
  ['the upsert query on_conflict', createExpectation(), createFacts({ url: `${API_ORIGIN}${API_PATH}?on_conflict=name` }), 'QUERY_MISMATCH'],
  ['a filter on a CREATE', createExpectation(), createFacts({ url: `${API_ORIGIN}${API_PATH}?id=eq.1` }), 'QUERY_MISMATCH'],
  ['select twice', createExpectation(), createFacts({ url: `${API_ORIGIN}${API_PATH}?select=*&select=id` }), 'QUERY_MISMATCH'],
  ['no select although it was approved', createExpectation(), createFacts({ url: `${API_ORIGIN}${API_PATH}` }), 'QUERY_MISMATCH'],
  ['an UPDATE without the filter', updateExpectation(), updateFacts({ url: `${API_ORIGIN}${API_PATH}?select=*` }), 'QUERY_MISMATCH'],
  ['two filters (another name)', updateExpectation(), updateFacts({ url: `${API_ORIGIN}${API_PATH}?id=eq.${RECORD_ID}&name=eq.x` }), 'QUERY_MISMATCH'],
  ['the same filter twice', updateExpectation(), updateFacts({ url: `${API_ORIGIN}${API_PATH}?id=eq.${RECORD_ID}&id=eq.1002` }), 'QUERY_MISMATCH'],
  ['the filter value rewritten', updateExpectation(), updateFacts({ url: `${API_ORIGIN}${API_PATH}?id=eq.1002&select=*` }), 'FILTER_MISMATCH'],
  ['the neq operator', updateExpectation(), updateFacts({ url: `${API_ORIGIN}${API_PATH}?id=neq.${RECORD_ID}&select=*` }), 'FILTER_MISMATCH'],
  ['the in operator', updateExpectation(), updateFacts({ url: `${API_ORIGIN}${API_PATH}?id=in.(${RECORD_ID},1002)&select=*` }), 'FILTER_MISMATCH'],
  ['the filter value with a suffix', updateExpectation(), updateFacts({ url: `${API_ORIGIN}${API_PATH}?id=eq.${RECORD_ID}0&select=*` }), 'FILTER_MISMATCH'],
  // ヘッダ
  ['a header that is not approved', createExpectation(), createFacts(withHeaders({ ...HEADERS, 'X-Extra': 'x' })), 'HEADER_NOT_ALLOWED'],
  ['text/plain', createExpectation(), createFacts(withHeaders({ ...HEADERS, 'Content-Type': 'text/plain;charset=UTF-8' })), 'CONTENT_TYPE_MISMATCH'],
  ['another charset', createExpectation(), createFacts(withHeaders({ ...HEADERS, 'Content-Type': 'application/json; charset=latin1' })), 'CONTENT_TYPE_MISMATCH'],
  ['another parameter', createExpectation(), createFacts(withHeaders({ ...HEADERS, 'Content-Type': 'application/json; boundary=x' })), 'CONTENT_TYPE_MISMATCH'],
  ['no Content-Type', createExpectation(), createFacts(withoutHeader('Content-Type')), 'CONTENT_TYPE_MISMATCH'],
  ['the upsert Prefer resolution=', createExpectation(), createFacts(withHeaders({ ...HEADERS, Prefer: 'return=representation,resolution=merge-duplicates' })), 'PREFER_MISMATCH'],
  ['an unknown Prefer item', createExpectation(), createFacts(withHeaders({ ...HEADERS, Prefer: 'return=representation, tx=rollback' })), 'PREFER_MISMATCH'],
  ['another return Prefer', createExpectation(), createFacts(withHeaders({ ...HEADERS, Prefer: 'return=minimal' })), 'PREFER_MISMATCH'],
  ['no Prefer', createExpectation(), createFacts(withoutHeader('Prefer')), 'PREFER_MISMATCH'],
  // 本文の形
  ['no body', createExpectation(), createFacts({ body: null }), 'BODY_UNAVAILABLE'],
  ['a body over the limit', createExpectation(), createFacts({ body: new Uint8Array(MAX_API_WRITE_BODY_BYTES + 1).fill(0x20) }), 'BODY_TOO_LARGE'],
  ['broken JSON', createExpectation(), createFacts(withBody('{"name":')), 'BODY_MALFORMED'],
  ['trailing text after the object', createExpectation(), createFacts(withBody(`${BODY_TEXT} x`)), 'BODY_MALFORMED'],
  ['two objects', createExpectation(), createFacts(withBody(`${BODY_TEXT}${BODY_TEXT}`)), 'BODY_MALFORMED'],
  ['invalid UTF-8', createExpectation(), createFacts({ body: new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]) }), 'BODY_MALFORMED'],
  ['a byte order mark', createExpectation(), createFacts({ body: bytesOf(`﻿${BODY_TEXT}`) }), 'BODY_MALFORMED'],
  ['a comment', createExpectation(), createFacts(withBody(`{"name":"x" /* c */}`)), 'BODY_MALFORMED'],
  ['single quotes', createExpectation(), createFacts(withBody("{'name':'x'}")), 'BODY_MALFORMED'],
  ['a number with a leading plus', createExpectation(), createFacts(withBody(`{"name":"${NAME_VALUE}","age":+42,"tenant_id":"t"}`)), 'BODY_MALFORMED'],
  ['an array at the top', createExpectation(), createFacts(withBody(`[${BODY_TEXT}]`)), 'BODY_NOT_OBJECT'],
  ['a string at the top', createExpectation(), createFacts(withBody('"x"')), 'BODY_NOT_OBJECT'],
  ['a duplicated key', createExpectation(), createFacts(withBody(`{"name":"other","name":"${NAME_VALUE}","age":42,"tenant_id":"t"}`)), 'BODY_DUPLICATE_KEY'],
  ['a duplicated key written with an escape', createExpectation(), createFacts(withBody(`{"name":"${NAME_VALUE}","na\\u006de":"x","age":42,"tenant_id":"t"}`)), 'BODY_DUPLICATE_KEY'],
  ['an array value of a page key', createExpectation(), createFacts(withBody(body({ ...BASE, tenant_id: [TENANT_VALUE] }))), 'BODY_VALUE_NOT_SCALAR'],
  ['a nested object value of a page key', createExpectation(), createFacts(withBody(body({ ...BASE, tenant_id: { id: 1 } }))), 'BODY_VALUE_NOT_SCALAR'],
  ['an array value of a key field', createExpectation(), createFacts(withBody(body({ ...BASE, name: [NAME_VALUE] }))), 'BODY_VALUE_NOT_SCALAR'],
  ['a nested object value of an extra key', createExpectation(), createFacts(withBody(body({ ...BASE, extra: { a: 1 } }))), 'BODY_VALUE_NOT_SCALAR'],
  // 鍵の集合
  ['a key added', createExpectation(), createFacts(withBody(body({ ...BASE, role: 'admin' }))), 'BODY_KEY_UNEXPECTED'],
  ['a key field removed', createExpectation(), createFacts(withBody(body({ name: NAME_VALUE, tenant_id: TENANT_VALUE }))), 'BODY_KEY_MISSING'],
  ['a page key removed', createExpectation(), createFacts(withBody(body({ name: NAME_VALUE, age: 42 }))), 'BODY_KEY_MISSING'],
  // 値と型
  ['a value rewritten', createExpectation(), createFacts(withBody(body({ ...BASE, name: 'rewritten' }))), 'BODY_VALUE_MISMATCH'],
  ['a number rewritten', createExpectation(), createFacts(withBody(body({ ...BASE, age: 43 }))), 'BODY_VALUE_MISMATCH'],
  ['"42" for the number 42', createExpectation(), createFacts(withBody(body({ ...BASE, age: '42' }))), 'BODY_VALUE_TYPE_MISMATCH'],
  ['42.0 for 42', createExpectation(), createFacts(withBody(`{"name":"${NAME_VALUE}","age":42.0,"tenant_id":"t"}`)), 'BODY_VALUE_MISMATCH'],
  ['4.2e1 for 42', createExpectation(), createFacts(withBody(`{"name":"${NAME_VALUE}","age":4.2e1,"tenant_id":"t"}`)), 'BODY_VALUE_MISMATCH'],
  ['-0 for 0', createExpectation({ values: { name: NAME_VALUE, age: '0' } }), createFacts(withBody(`{"name":"${NAME_VALUE}","age":-0,"tenant_id":"t"}`)), 'BODY_VALUE_MISMATCH'],
  ['the number 1 for the string "1"', createExpectation({ values: { name: '1', age: AGE_VALUE } }), createFacts(withBody(body({ ...BASE, name: 1 }))), 'BODY_VALUE_TYPE_MISMATCH'],
  ['null for a string', createExpectation(), createFacts(withBody(body({ ...BASE, name: null }))), 'BODY_VALUE_TYPE_MISMATCH'],
  ['a number for a string page key', createExpectation(), createFacts(withBody(body({ ...BASE, tenant_id: 7 }))), 'BODY_VALUE_TYPE_MISMATCH'],
  // 期待の誤り（fail-closed）
  ['a generated value missing', createExpectation({ values: { name: NAME_VALUE } }), createFacts(), 'EXPECTATION_INVALID'],
  ['a generated value not of the number form', createExpectation({ values: { name: NAME_VALUE, age: '4x' } }), createFacts(), 'EXPECTATION_INVALID'],
  ['a page key of an object type', createExpectation({ spec: createSpec({ pageKeys: [{ key: 'tenant_id', type: 'object' }] }) }), createFacts(), 'EXPECTATION_INVALID'],
  ['a page key with a secret-like name', createExpectation({ spec: createSpec({ pageKeys: [{ key: 'api_key', type: 'string' }] }) }), createFacts(), 'EXPECTATION_INVALID'],
  ['a key both a key field and a page key', createExpectation({ spec: createSpec({ pageKeys: [{ key: 'name', type: 'string' }] }) }), createFacts(), 'EXPECTATION_INVALID'],
  ['an UPDATE without the ledger id', updateExpectation({ recordId: null }), updateFacts(), 'EXPECTATION_INVALID'],
  ['a CREATE with a ledger id', createExpectation({ recordId: RECORD_ID }), createFacts(), 'EXPECTATION_INVALID'],
  ['a CREATE with a filter name', createExpectation({ spec: createSpec({ filterName: 'id' }) }), createFacts(), 'EXPECTATION_INVALID'],
  ['a method that is not POST nor PATCH', createExpectation({ spec: createSpec({ request: { ...createSpec().request, method: 'PUT' as 'POST' } }) }), createFacts({ method: 'PUT' }), 'EXPECTATION_INVALID'],
  ['an origin that is not an origin', createExpectation({ spec: createSpec({ request: { ...createSpec().request, origin: `${API_ORIGIN}/x` } }) }), createFacts(), 'EXPECTATION_INVALID'],
  ['a redacted path shape', createExpectation({ spec: createSpec({ request: { ...createSpec().request, pathShape: '/rest/[REDACTED]' } }) }), createFacts(), 'EXPECTATION_INVALID'],
  // T39R-fix（M-4）: upsert の `Prefer`（`resolution=`）と、手続きの呼び出しの path（分類と同じ形で decode して畳む）は、承認の期待の誤り（I21）。
  ...(['resolution=merge-duplicates', 'resolution=ignore-duplicates'] as const).map((prefer): BlockRow => [
    `an approved upsert Prefer ${prefer}`,
    createExpectation({ spec: createSpec({ request: { ...createSpec().request, prefer: ['return=representation', prefer] } }) }),
    createFacts(withHeaders({ ...HEADERS, Prefer: `return=representation, ${prefer}` })),
    'EXPECTATION_INVALID',
  ]),
  ...['/rest/v1/rpc/search', '/rest/v1/RPC/search', '/rest/v1/%72pc/search', '/rest/v1/%2572pc/search', '/rest/v1/rpc;x/search', '/rest/v1/x/../rpc/search', '/rest/v1/rpc']
    .map((pathShape): BlockRow => [
      `an approved procedure call path ${pathShape}`,
      createExpectation({ spec: createSpec({ request: { ...createSpec().request, pathShape } }) }),
      createFacts({ url: `${API_ORIGIN}${pathShape}?select=*` }),
      'EXPECTATION_INVALID',
    ]),
];

describe('T39a: the adversarial requests are blocked with a closed reason and no value', () => {
  it.each(BLOCKED)('blocks %s', (_label, expectation, facts, reason) => {
    const result = checkApiWritePayload(expectation, facts);
    expect(result).toEqual({ decision: reason });
    expectNoLeak(result, false);
  });

  it('never throws, and blocks inputs of a wrong form', () => {
    const broken: readonly [unknown, unknown][] = [
      [null, createFacts()],
      [createExpectation(), null],
      [createExpectation({ values: null as unknown as Record<string, string> }), createFacts()],
      [createExpectation(), createFacts({ headers: null as unknown as Record<string, string> })],
      [createExpectation(), createFacts({ body: 'text' as unknown as Uint8Array })],
      [createExpectation({ spec: { ...createSpec(), keyFields: null } as unknown as ScenarioApiSpec }), createFacts()],
    ];
    for (const [expectation, facts] of broken) {
      const result = checkApiWritePayload(expectation as ApiWritePayloadExpectation, facts as ApiWriteRequestFacts);
      expect(result.decision).not.toBe('ALLOW');
      expectNoLeak(result, false);
    }
  });
});
