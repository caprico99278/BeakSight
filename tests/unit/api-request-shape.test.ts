// T37b（Task 37 の設計書 3.2 の「記録する型」の表、4 章）: 送らずに観察する probe で、Guard が止めた本番の要求から作る型（`src/core/api-request-shape.ts`）。
// - 表の各項目（method、要求の種類、Origin の区分、path の型、query の名前、filter の形、ヘッダの名前、`Content-Type` の媒体の型、`Prefer` の閉じた一覧の値、
//   本文の最上位の形、鍵の名前と値の JSON の型、鍵と目印の対応）。
// - 値（本文の値、query の値、ヘッダの値、目印の値）は、型にも例外の文にも残らない（I22）。上限（鍵の数、名前の長さ、ほか）は名前つきの定数。
// 例の値は匿名の値だけ（実在の token ではない）。
import { describe, expect, it } from 'vitest';
import { REDACTED } from '../../src/core/redaction.js';
import { PATH_TEMPLATE_ID_SEGMENT } from '../../src/core/record-id-path-pattern.js';
import {
  API_PREFER_SHAPES,
  apiArrayElementsOf,
  apiContentTypePartsOf,
  apiPreferItemsOf,
  apiRequestShapeOf,
  apiShapeApprovedOriginOf,
  hasApiProcedureCallSegment,
  isRecordIdLikePathSegment,
  type ApiRequestShapeContext,
  type ApiRequestShapeInput,
} from '../../src/core/api-request-shape.js';

const APP = 'https://app.example.test';
const API = 'https://api.example.test';
const OTHER_API = 'https://other-api.example.test';
const ELSEWHERE = 'https://elsewhere.example.test';
const MARKER_NAME = 'bsmarkerNameQ7';
const MARKER_EMAIL = 'bsmarkerMailZ3@example.invalid';
const MARKER_NUMBER = '730194';
const SECRET_API_KEY = 'kSecretApiKeyValue0123456789abcdef';
const SECRET_BEARER = 'Bearer aSecretAccessTokenValue0123456789';
const UUID = '550e8400-e29b-41d4-a716-446655440000';

const CONTEXT: ApiRequestShapeContext = Object.freeze({
  pagePath: '/admin/members/42/edit',
  markers: [MARKER_NAME, MARKER_EMAIL, MARKER_NUMBER],
});

const jsonBody = (value: unknown): ApiRequestShapeInput['body'] => ({ kind: 'TEXT', text: JSON.stringify(value) });

const inputOf = (overrides: Partial<ApiRequestShapeInput> = {}): ApiRequestShapeInput => ({
  method: 'PATCH',
  resourceType: 'fetch',
  url: `${API}/rest/v1/members?id=eq.42&select=*`,
  origin: { kind: 'APPROVED_API', index: 1 },
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    apikey: SECRET_API_KEY,
    Authorization: SECRET_BEARER,
    Prefer: 'return=representation',
  },
  body: jsonBody({ name: MARKER_NAME, email: MARKER_EMAIL, note: `note ${MARKER_NUMBER}`, age: 3, active: true, extra: null, tags: [], meta: {} }),
  ...overrides,
});

/** 値（目印、秘密、query の値）が、型の JSON のどこにも残らない。 */
const expectNoValues = (shape: unknown): void => {
  const text = JSON.stringify(shape);
  for (const value of [MARKER_NAME, MARKER_EMAIL, MARKER_NUMBER, SECRET_API_KEY, SECRET_BEARER, 'aSecretAccessTokenValue', 'eq.42']) {
    expect(text).not.toContain(value);
  }
};

describe('apiRequestShapeOf (T37b: the shape of a blocked request, without values)', () => {
  it('records each item of the shape table of the design 3.2', () => {
    const shape = apiRequestShapeOf(inputOf(), CONTEXT);
    expect(shape).toEqual({
      method: 'PATCH',
      resourceType: 'fetch',
      origin: { kind: 'APPROVED_API', index: 1 },
      pathShape: '/rest/v1/members',
      queryNames: ['id', 'select'],
      omittedQueryNameCount: 0,
      filters: [{ name: 'id', operator: 'eq', valueMatchesPagePath: true, valueIsRecordIdLike: true }],
      headerNames: ['apikey', 'authorization', 'content-type', 'prefer'],
      omittedHeaderNameCount: 0,
      contentType: 'application/json',
      prefer: ['return=representation'],
      body: {
        kind: 'OBJECT',
        keys: [
          { name: 'active', type: 'boolean' },
          { name: 'age', type: 'number' },
          { name: 'email', type: 'string' },
          { name: 'extra', type: 'null' },
          { name: 'meta', type: 'object' },
          { name: 'name', type: 'string' },
          { name: 'note', type: 'string' },
          // ARR-1: 一覧の鍵は要素の情報（型の集合・数・入れ子・文字の上限の超過）を持つ。値は持たない。
          { name: 'tags', type: 'array', elements: { types: [], count: 0, nested: false, textOverLimit: false } },
        ],
        omittedKeyCount: 0,
        markerKeys: [
          { key: 'email', markers: [1] },
          { key: 'name', markers: [0] },
          { key: 'note', markers: [2] },
        ],
        // 論理削除の鍵の判定を渡していない文脈では偽（判定は観察の口が渡す。下のテスト）。
        stateKeyPresent: false,
      },
    });
    expectNoValues(shape);
  });

  it('keeps only whether a key is a state key, judged by the given predicate with the name before hiding (T37R-fix-A I-3)', () => {
    const seen: string[] = [];
    const longStateName = `deleted_${MARKER_NAME}`;
    const shape = apiRequestShapeOf(inputOf({ body: jsonBody({ name: MARKER_NAME, [longStateName]: true }) }), {
      ...CONTEXT,
      isStateKeyName: (name) => {
        seen.push(name);
        return name.startsWith('deleted_');
      },
    });
    expect(seen).toContain(longStateName);
    expect(shape.body.stateKeyPresent).toBe(true);
    expect(shape.body.keys.map(({ name }) => name)).toEqual([REDACTED, 'name']);
    expect(JSON.stringify(shape)).not.toContain('deleted_');
    const plain = apiRequestShapeOf(inputOf({ body: jsonBody({ name: 'n' }) }), { ...CONTEXT, isStateKeyName: () => false });
    expect(plain.body.stateKeyPresent).toBe(false);
    const throwing = apiRequestShapeOf(inputOf({ body: jsonBody({ name: 'n' }) }), { ...CONTEXT, isStateKeyName: () => {
      throw new Error('predicate failure');
    } });
    // 判定が投げたら、安全の側（状態の鍵があるとみなす）。
    expect(throwing.body.stateKeyPresent).toBe(true);
  });

  it('compares the filter value with the last ID-like segment of the page path only (T37R-fix-A M-1)', () => {
    const filtersOf = (query: string) =>
      apiRequestShapeOf(inputOf({ url: `${API}/rest/v1/members?${query}` }), { ...CONTEXT, pagePath: '/orgs/7/members/1/edit' }).filters;
    expect(filtersOf('org_id=eq.7')).toEqual([{ name: 'org_id', operator: 'eq', valueMatchesPagePath: false, valueIsRecordIdLike: true }]);
    expect(filtersOf('id=eq.1')).toEqual([{ name: 'id', operator: 'eq', valueMatchesPagePath: true, valueIsRecordIdLike: true }]);
    expect(apiRequestShapeOf(inputOf({ url: `${API}/rest/v1/members?id=eq.1` }), { ...CONTEXT, pagePath: '/admin/members/new' }).filters)
      .toEqual([{ name: 'id', operator: 'eq', valueMatchesPagePath: false, valueIsRecordIdLike: true }]);
  });

  it('keeps the Origin class decided by the caller (the Origin owner), and makes a malformed one or an unreadable URL another', () => {
    expect(apiRequestShapeOf(inputOf({ url: `${OTHER_API}/rest/v1/members`, origin: { kind: 'APPROVED_API', index: 0 } }), CONTEXT).origin)
      .toEqual({ kind: 'APPROVED_API', index: 0 });
    expect(apiRequestShapeOf(inputOf({ url: `${APP}/api/members`, origin: { kind: 'ALLOWED' } }), CONTEXT).origin).toEqual({ kind: 'ALLOWED' });
    expect(apiRequestShapeOf(inputOf({ url: `${ELSEWHERE}/rest/v1/members`, origin: { kind: 'OTHER' } }), CONTEXT).origin).toEqual({ kind: 'OTHER' });
    expect(apiRequestShapeOf(inputOf({ origin: { kind: 'APPROVED_API', index: -1 } }), CONTEXT).origin).toEqual({ kind: 'OTHER' });
    expect(apiRequestShapeOf(inputOf({ url: 'not a url' }), CONTEXT)).toMatchObject({ origin: { kind: 'OTHER' }, pathShape: REDACTED, queryNames: [] });
    // DEF-220: 承認したテストの Origin の区分も、番号ごと写す（形が違えば「そのほか」）。
    expect(apiRequestShapeOf(inputOf({ url: `${APP}/api/members`, origin: { kind: 'APPROVED_TEST', index: 2 } }), CONTEXT).origin)
      .toEqual({ kind: 'APPROVED_TEST', index: 2 });
    expect(apiRequestShapeOf(inputOf({ origin: { kind: 'APPROVED_TEST', index: 1.5 } }), CONTEXT).origin).toEqual({ kind: 'OTHER' });
  });

  it('DEF-220: resolves the index of the Origin class to the Origin with the list of its own kind only (apiShapeApprovedOriginOf)', () => {
    const lists = { approvedServiceOrigins: [API, OTHER_API], approvedTestOrigins: [APP] };
    expect(apiShapeApprovedOriginOf({ kind: 'APPROVED_API', index: 1 }, lists)).toBe(OTHER_API);
    expect(apiShapeApprovedOriginOf({ kind: 'APPROVED_TEST', index: 0 }, lists)).toBe(APP);
    // 番号の意味を混ぜない: テストの番号はサービスの一覧で解かず、その逆もしない。
    expect(apiShapeApprovedOriginOf({ kind: 'APPROVED_TEST', index: 1 }, lists)).toBeUndefined();
    expect(apiShapeApprovedOriginOf({ kind: 'APPROVED_API', index: 0 }, { approvedTestOrigins: [APP] })).toBeUndefined();
    expect(apiShapeApprovedOriginOf({ kind: 'APPROVED_TEST', index: 0 }, { approvedServiceOrigins: [API] })).toBeUndefined();
    expect(apiShapeApprovedOriginOf({ kind: 'ALLOWED' }, lists)).toBeUndefined();
    expect(apiShapeApprovedOriginOf({ kind: 'OTHER' }, lists)).toBeUndefined();
  });

  it('hides the value-like path segments and the segments that carry a marker', () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJleGFtcGxlIn0.c2lnbmF0dXJl';
    expect(apiRequestShapeOf(inputOf({ url: `${API}/rest/v1/${token}/members` }), CONTEXT).pathShape).toBe(`/rest/v1/${REDACTED}/members`);
    expect(apiRequestShapeOf(inputOf({ url: `${API}/rest/v1/members/${MARKER_NUMBER}` }), CONTEXT).pathShape).toBe(`/rest/v1/members/${REDACTED}`);
    expect(apiRequestShapeOf(inputOf({ url: `${API}/rest/v1/members/x${encodeURIComponent(MARKER_NAME)}y` }), CONTEXT).pathShape)
      .toBe(`/rest/v1/members/${REDACTED}`);
    expect(apiRequestShapeOf(inputOf({ url: `${API}/rest/v1/rpc/upsert_member` }), CONTEXT).pathShape).toBe('/rest/v1/rpc/upsert_member');
  });

  it('reads the filter shape: the name, the operator (only eq is read) and whether the value is the value of the page path', () => {
    const filtersOf = (query: string, pagePath = CONTEXT.pagePath) =>
      apiRequestShapeOf(inputOf({ url: `${API}/rest/v1/members?${query}` }), { ...CONTEXT, pagePath }).filters;
    expect(filtersOf('id=eq.42')).toEqual([{ name: 'id', operator: 'eq', valueMatchesPagePath: true, valueIsRecordIdLike: true }]);
    expect(filtersOf('id=eq.43')).toEqual([{ name: 'id', operator: 'eq', valueMatchesPagePath: false, valueIsRecordIdLike: true }]);
    expect(filtersOf('id=eq.members')).toEqual([{ name: 'id', operator: 'eq', valueMatchesPagePath: false, valueIsRecordIdLike: false }]);
    expect(filtersOf('id=eq.edit')).toEqual([{ name: 'id', operator: 'eq', valueMatchesPagePath: false, valueIsRecordIdLike: false }]);
    expect(filtersOf('id=neq.42')).toEqual([{ name: 'id', operator: 'OTHER', valueMatchesPagePath: false, valueIsRecordIdLike: false }]);
    expect(filtersOf('id=42')).toEqual([{ name: 'id', operator: 'OTHER', valueMatchesPagePath: false, valueIsRecordIdLike: false }]);
    expect(filtersOf(`id=eq.${UUID}`, `/admin/members/${UUID}/edit`)).toEqual([{ name: 'id', operator: 'eq', valueMatchesPagePath: true, valueIsRecordIdLike: true }]);
    expect(filtersOf('select=*&on_conflict=id')).toEqual([]);
    expect(filtersOf('id=eq.42&email=eq.x')).toEqual([
      { name: 'email', operator: 'eq', valueMatchesPagePath: false, valueIsRecordIdLike: false },
      { name: 'id', operator: 'eq', valueMatchesPagePath: true, valueIsRecordIdLike: true },
    ]);
  });

  // LU-2（設計書 `2026-11-02-beaksight-list-row-update-design.md` 5.2 の 1・2）: path の最後の番号の区切りだけを `{id}` にし、filter の値が番号の形かを残す。
  it('makes only the last record number segment of the path the {id} segment (LU-2)', () => {
    const pathOf = (path: string) => apiRequestShapeOf(inputOf({ url: `${API}${path}` }), CONTEXT).pathShape;
    expect(pathOf('/api/items/4')).toBe(`/api/items/${PATH_TEMPLATE_ID_SEGMENT}`);
    expect(pathOf(`/api/items/${UUID}`)).toBe(`/api/items/${PATH_TEMPLATE_ID_SEGMENT}`);
    expect(pathOf(`/api/items/${UUID.toUpperCase()}`)).toBe(`/api/items/${PATH_TEMPLATE_ID_SEGMENT}`);
    // 途中の区切りの番号は変えない。番号のない path も変えない。
    expect(pathOf('/projects/7/items')).toBe('/projects/7/items');
    expect(pathOf('/api/items')).toBe('/api/items');
    expect(pathOf('/api/items/v2')).toBe('/api/items/v2');
    expect(pathOf('/api/items/4/')).toBe('/api/items/4/');
    expect(pathOf('/projects/7/items/4')).toBe(`/projects/7/items/${PATH_TEMPLATE_ID_SEGMENT}`);
    // 伏せ字の区切り（値に見える区切り・目印を含む区切り）は `{id}` にしない。
    expect(pathOf(`/api/items/${'a'.repeat(32)}${'0'.repeat(32)}`)).toBe(`/api/items/${REDACTED}`);
    expect(pathOf(`/api/items/${MARKER_NUMBER}`)).toBe(`/api/items/${REDACTED}`);
  });

  it('keeps whether the filter value is a record number (digits or UUID), without the value (LU-2)', () => {
    const filtersOf = (query: string) =>
      apiRequestShapeOf(inputOf({ url: `${API}/api/items?${query}` }), { ...CONTEXT, pagePath: '/items' }).filters;
    const filterOf = (valueIsRecordIdLike: boolean, operator = 'eq') => [{ name: 'id', operator, valueMatchesPagePath: false, valueIsRecordIdLike }];
    expect(filtersOf('id=eq.3')).toEqual(filterOf(true));
    expect(filtersOf(`id=eq.${UUID}`)).toEqual(filterOf(true));
    expect(filtersOf('id=eq.abc')).toEqual(filterOf(false));
    expect(filtersOf('id=eq.')).toEqual(filterOf(false));
    // 値に見える長い文字は番号の形にしない（path の型で伏せる区切りと同じく、番号の形は数字と UUID だけ）。
    expect(filtersOf(`id=eq.${'a'.repeat(32)}${'0'.repeat(32)}`)).toEqual(filterOf(false));
    expect(filtersOf('id=gt.3')).toEqual(filterOf(false, 'OTHER'));
    expect(JSON.stringify(filtersOf('id=eq.3'))).not.toContain('eq.3');
  });

  it.each([
    ['42', true],
    [UUID, true],
    ['members', false],
    ['edit', false],
    ['', false],
    ['v2', false],
    ['a'.repeat(32) + '0'.repeat(32), true],
  ])('treats the page path segment %j as a record ID: %s', (segment, expected) => {
    expect(isRecordIdLikePathSegment(segment)).toBe(expected);
  });

  it('records the Prefer values only from the closed list', () => {
    const preferOf = (value: string) => apiRequestShapeOf(inputOf({ headers: { prefer: value } }), CONTEXT).prefer;
    expect(preferOf('return=minimal, resolution=merge-duplicates')).toEqual(['resolution=merge-duplicates', 'return=minimal']);
    expect(preferOf('return=secret-value-123, resolution=whatever')).toEqual(['resolution=other', 'return=other']);
    expect(preferOf('tx=commit')).toEqual(['other']);
    expect(preferOf('')).toEqual([]);
    for (const value of preferOf('return=representation,resolution=ignore-duplicates,count=exact')) {
      expect(API_PREFER_SHAPES).toContain(value);
    }
  });

  it('records the media type of Content-Type only (no parameters), and hides a malformed one', () => {
    expect(apiRequestShapeOf(inputOf({ headers: { 'content-type': 'Text/Plain;charset=UTF-8' } }), CONTEXT).contentType).toBe('text/plain');
    expect(apiRequestShapeOf(inputOf({ headers: { 'content-type': `x ${SECRET_API_KEY}` } }), CONTEXT).contentType).toBe(REDACTED);
    expect(apiRequestShapeOf(inputOf({ headers: {} }), CONTEXT).contentType).toBeNull();
    // L13（N25）: 媒体の型は長さでは伏せない（前は 100 文字を超えたら伏せた）。
    const longMediaType = `application/${'x'.repeat(120)}`;
    expect(apiRequestShapeOf(inputOf({ headers: { 'content-type': longMediaType } }), CONTEXT).contentType).toBe(longMediaType);
  });

  it('records the top-level body form: object, array, scalar JSON, not JSON, none, unreadable', () => {
    const bodyOf = (body: ApiRequestShapeInput['body']) => apiRequestShapeOf(inputOf({ body }), CONTEXT).body;
    const empty = (kind: string) => ({ kind, keys: [], omittedKeyCount: 0, markerKeys: [], stateKeyPresent: false });
    expect(bodyOf(jsonBody([{ name: MARKER_NAME }]))).toEqual(empty('ARRAY'));
    expect(bodyOf(jsonBody(MARKER_NAME))).toEqual(empty('SCALAR'));
    expect(bodyOf({ kind: 'TEXT', text: `name=${MARKER_NAME}` })).toEqual(empty('NOT_JSON'));
    expect(bodyOf({ kind: 'NONE' })).toEqual(empty('NONE'));
    expect(bodyOf({ kind: 'UNREADABLE' })).toEqual(empty('UNREADABLE'));
  });

  // L13（N25）: 本文の大きさで読まないことはない（前は 64KiB を超えたら「読めない」）。
  it('reads a body of any size', () => {
    const shape = apiRequestShapeOf(inputOf({ body: jsonBody({ a: 'é'.repeat(70_000), name: MARKER_NAME }) }), CONTEXT);
    expect(shape.body.kind).toBe('OBJECT');
    expect(shape.body.markerKeys).toEqual([{ key: 'name', markers: [0] }]);
  });

  it('splits Prefer into items and Content-Type into the media type and the parameters in the one way of the contract (T39R-fix M-5)', () => {
    expect(apiPreferItemsOf(' Return=Minimal , ,resolution=Merge-Duplicates ')).toEqual(['return=minimal', 'resolution=merge-duplicates']);
    expect(apiPreferItemsOf('')).toEqual([]);
    expect(apiPreferItemsOf('return=representation; handling=lenient')).toEqual(['return=representation; handling=lenient']);
    expect(apiContentTypePartsOf(' Application/JSON ; charset=UTF-8')).toEqual({ mediaType: 'application/json', parameters: [' charset=UTF-8'] });
    expect(apiContentTypePartsOf('text/plain')).toEqual({ mediaType: 'text/plain', parameters: [] });
    expect(apiContentTypePartsOf('')).toEqual({ mediaType: '', parameters: [] });
  });

  it.each([
    ['/rest/v1/rpc/search', true],
    ['/rest/v1/RPC/search', true],
    ['/rest/v1/%72pc/search', true],
    ['/rest/v1/%2572pc/search', true],
    ['/rest/v1/rpc;x/search', true],
    ['/rest/v1/x/../rpc/search', true],
    ['/rest/v1/rpc', true],
    [`/rest/v1/${encodeURIComponent('ｒｐｃ')}/search`, true],
    ['/rest/v1/%E0%A4%A/search', true],
    ['/rest/v1/members', false],
    ['/rest/v1/rpcx', false],
    ['/rest/v1/members_rpc', false],
  ])('finds the procedure call segment in the path %j: %s (T39R-fix M-4, the part shared by the classification and the check)', (path, expected) => {
    expect(hasApiProcedureCallSegment(path)).toBe(expected);
  });

  it('hides the names that look like values or carry a marker, and keeps a long name (keys, query names, header names)', () => {
    // L13（N25）: 長さでは伏せない（前は 64 文字を超えたら伏せた）。
    const longName = 'n'.repeat(100);
    const shape = apiRequestShapeOf(inputOf({
      url: `${API}/rest/v1/members?${encodeURIComponent(MARKER_NAME)}=1&${longName}=2&${SECRET_API_KEY}=3`,
      headers: { [`x-${MARKER_NAME}`]: 'v', [longName]: 'v' },
      body: jsonBody({ [MARKER_EMAIL]: 'a', [longName]: 'b', [SECRET_API_KEY]: 'c', ok: MARKER_NAME }),
    }), CONTEXT);
    expect(shape.queryNames).toEqual([REDACTED, REDACTED, longName]);
    expect(shape.headerNames).toEqual([REDACTED, longName]);
    expect(shape.body.keys.map(({ name }) => name)).toEqual([REDACTED, REDACTED, longName, 'ok']);
    expectNoValues(shape);
  });

  // L13（N25）: 本文の鍵・query の名前・ヘッダの名前・目印は、数で切らない（前は 64・32・64・32）。
  it('keeps all the body keys, query names, header names and markers', () => {
    const many = (count: number, prefix: string) => Array.from({ length: count }, (_, index) => `${prefix}${String(index).padStart(3, '0')}`);
    const keys = many(65, 'k');
    const queries = many(33, 'q');
    const headers = many(65, 'h');
    const markers = Array.from({ length: 33 }, (_, index) => `${MARKER_NAME}m${String(index).padStart(3, '0')}`);
    const shape = apiRequestShapeOf(inputOf({
      url: `${API}/rest/v1/members?${queries.map((name) => `${name}=1`).join('&')}`,
      headers: Object.fromEntries(headers.map((name) => [name, 'v'])),
      body: jsonBody({ ...Object.fromEntries(keys.map((name) => [name, 1])), last: markers.at(-1) }),
    }), { ...CONTEXT, markers });
    expect(shape.body.keys).toHaveLength(66);
    expect(shape.body.omittedKeyCount).toBe(0);
    expect(shape.queryNames).toHaveLength(33);
    expect(shape.filters).toHaveLength(33);
    expect(shape.omittedQueryNameCount).toBe(0);
    expect(shape.headerNames).toHaveLength(65);
    expect(shape.omittedHeaderNameCount).toBe(0);
    expect(shape.body.markerKeys).toEqual([{ key: 'last', markers: [32] }]);
  });

  it('rejects a marker that is not a string, without the values in the message', () => {
    expect(() => apiRequestShapeOf(inputOf(), { ...CONTEXT, markers: [MARKER_NAME, 1 as unknown as string] })).toThrow(TypeError);
    try {
      apiRequestShapeOf(inputOf(), { ...CONTEXT, markers: [MARKER_NAME, 1 as unknown as string] });
    } catch (error) {
      expect(String(error)).not.toContain(MARKER_NAME);
    }
  });

  it('does not keep a marker match from a nested value, and matches a number value by its text', () => {
    const shape = apiRequestShapeOf(inputOf({ body: jsonBody({ nested: { name: MARKER_NAME }, count: Number(MARKER_NUMBER) }) }), CONTEXT);
    expect(shape.body.markerKeys).toEqual([{ key: 'count', markers: [2] }]);
    expectNoValues(shape);
  });

  it('does not mark a key with a value that is not an array as in an array', () => {
    const shape = apiRequestShapeOf(inputOf({ body: jsonBody({ name: MARKER_NAME, age: 3 }) }), CONTEXT);
    expect(shape.body.keys).toEqual([{ name: 'age', type: 'number' }, { name: 'name', type: 'string' }]);
    expect(shape.body.markerKeys).toEqual([{ key: 'name', markers: [0] }]);
  });

  it('normalizes the method and the resource type, and hides an unexpected method', () => {
    expect(apiRequestShapeOf(inputOf({ method: 'post', resourceType: 'xhr' }), CONTEXT)).toMatchObject({ method: 'POST', resourceType: 'xhr' });
    expect(apiRequestShapeOf(inputOf({ method: `X ${SECRET_API_KEY}` }), CONTEXT).method).toBe(REDACTED);
    expect(apiRequestShapeOf(inputOf({ resourceType: 'Fetch Secret' }), CONTEXT).resourceType).toBe('other');
  });
});

// ARR-1（設計書 `2026-11-08-beaksight-api-array-keys-design.md` 3.2）: 一覧の形の値（array）の鍵は、要素の型の集合・数・入れ子の有無・文字の上限の
// 超過を持つ（値は持たない）。要素の文字（か数）に目印が入れば、その鍵を目印の鍵の一覧に入れ、一覧の中で見つかった印（`inArray`）を付ける。
describe('apiRequestShapeOf (ARR-1: the elements of an array key)', () => {
  const keyOf = (body: unknown, name: string) =>
    apiRequestShapeOf(inputOf({ body: jsonBody(body) }), CONTEXT).body.keys.find((key) => key.name === name);

  it('records an empty array', () => {
    expect(keyOf({ tags: [] }, 'tags')).toEqual({ name: 'tags', type: 'array', elements: { types: [], count: 0, nested: false, textOverLimit: false } });
  });

  it('records an array of texts, an array of numbers and an array of mixed scalars (the set of types is sorted)', () => {
    expect(keyOf({ tags: ['a', 'b', 'c'] }, 'tags')?.elements).toEqual({ types: ['string'], count: 3, nested: false, textOverLimit: false });
    expect(keyOf({ ids: [1, 2] }, 'ids')?.elements).toEqual({ types: ['number'], count: 2, nested: false, textOverLimit: false });
    expect(keyOf({ mixed: [true, null, 'x', 2] }, 'mixed')?.elements)
      .toEqual({ types: ['boolean', 'null', 'number', 'string'], count: 4, nested: false, textOverLimit: false });
  });

  it('records a nested array (an element that is an object or an array) without looking into it', () => {
    // ARR-5（`arr-5-array-object-rows.test.ts`）: object の行は、中の鍵と印を見るようにした（目印のない object の行と、一覧の中の一覧は今のまま中を見ない）。
    expect(keyOf({ rows: [{ name: 'x' }] }, 'rows')?.elements).toEqual({ types: ['object'], count: 1, nested: true, textOverLimit: false });
    expect(keyOf({ rows: [['a'], 'b'] }, 'rows')?.elements).toEqual({ types: ['array', 'string'], count: 2, nested: true, textOverLimit: false });
    const shape = apiRequestShapeOf(inputOf({ body: jsonBody({ rows: [{ name: MARKER_NAME }], deep: [[MARKER_EMAIL]] }) }), CONTEXT);
    expect(shape.body.markerKeys).toEqual([{ key: 'rows', markers: [0], inArray: true }]);
    expect(shape.body.keys.find(({ name }) => name === 'rows')?.elements?.positions)
      .toEqual([{ markers: [], empty: false, type: 'object', keys: [{ name: 'name', markers: [0], empty: false, type: 'string' }] }]);
    expectNoValues(shape);
  });

  // L13 fix round 1: 一覧の要素の数・文字の長さ・行の中の鍵の数に上限を置かない（前は 20・200・16。超えた一覧は位置の情報を持たず、文字は上限の超過の印）。
  it('records the positions of a long list, a long text and a row of many inner keys without a limit', () => {
    const many = [MARKER_NAME, ...Array.from({ length: 20 }, () => '')];
    const elements = keyOf({ tags: many }, 'tags')?.elements;
    expect(elements).toMatchObject({ types: ['string'], count: 21, nested: false, textOverLimit: false });
    expect(elements?.positions).toHaveLength(21);
    expect(keyOf({ tags: ['x'.repeat(201)] }, 'tags')?.elements?.textOverLimit).toBe(false);
    const row = { name: MARKER_NAME, ...Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`k${String(index).padStart(2, '0')}`, 'y'.repeat(201)])) };
    const inner = keyOf({ rows: [row] }, 'rows')?.elements?.positions?.[0]?.keys;
    expect(inner).toHaveLength(17);
    expect(inner?.some((key) => key.textOverLimit === true)).toBe(false);
  });

  it('puts a key whose text or number element carries a marker into the marker keys, marked as in an array, without the values', () => {
    const shape = apiRequestShapeOf(inputOf({
      body: jsonBody({ name: MARKER_NAME, labels: [MARKER_EMAIL], codes: [Number(MARKER_NUMBER), 5], both: [`a ${MARKER_NAME}`, MARKER_EMAIL], plain: ['a'] }),
    }), CONTEXT);
    expect(shape.body.markerKeys).toEqual([
      { key: 'both', markers: [0, 1], inArray: true },
      { key: 'codes', markers: [2], inArray: true },
      { key: 'labels', markers: [1], inArray: true },
      { key: 'name', markers: [0] },
    ]);
    expectNoValues(shape);
  });

  it('collects the same marker once even when two elements carry it', () => {
    const shape = apiRequestShapeOf(inputOf({ body: jsonBody({ labels: [MARKER_NAME, `x${MARKER_NAME}`] }) }), CONTEXT);
    expect(shape.body.markerKeys).toEqual([{ key: 'labels', markers: [0], inArray: true }]);
  });

  it('shares the element summary for the later check of the write stage (the same summary as the shape)', () => {
    expect(apiArrayElementsOf(['a', 1])).toEqual({ types: ['number', 'string'], count: 2, nested: false, textOverLimit: false });
    expect(apiArrayElementsOf([{}])).toMatchObject({ nested: true });
  });
});
