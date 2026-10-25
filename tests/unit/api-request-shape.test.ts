// T37b（Task 37 の設計書 3.2 の「記録する型」の表、4 章）: 送らずに観察する probe で、Guard が止めた本番の要求から作る型（`src/core/api-request-shape.ts`）。
// - 表の各項目（method、要求の種類、Origin の区分、path の型、query の名前、filter の形、ヘッダの名前、`Content-Type` の媒体の型、`Prefer` の閉じた一覧の値、
//   本文の最上位の形、鍵の名前と値の JSON の型、鍵と目印の対応）。
// - 値（本文の値、query の値、ヘッダの値、目印の値）は、型にも例外の文にも残らない（I22）。上限（鍵の数、名前の長さ、ほか）は名前つきの定数。
// 例の値は匿名の値だけ（実在の token ではない）。
import { describe, expect, it } from 'vitest';
import { REDACTED } from '../../src/core/redaction.js';
import {
  API_PREFER_SHAPES,
  MAX_API_REQUEST_BODY_BYTES,
  MAX_API_SHAPE_BODY_KEYS,
  MAX_API_SHAPE_HEADER_NAMES,
  MAX_API_SHAPE_MARKERS,
  MAX_API_SHAPE_NAME_LENGTH,
  MAX_API_SHAPE_QUERY_NAMES,
  apiContentTypePartsOf,
  apiPreferItemsOf,
  apiRequestShapeOf,
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
      filters: [{ name: 'id', operator: 'eq', valueMatchesPagePath: true }],
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
          { name: 'tags', type: 'array' },
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
    const longStateName = `deleted_${'x'.repeat(MAX_API_SHAPE_NAME_LENGTH)}`;
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
    expect(filtersOf('org_id=eq.7')).toEqual([{ name: 'org_id', operator: 'eq', valueMatchesPagePath: false }]);
    expect(filtersOf('id=eq.1')).toEqual([{ name: 'id', operator: 'eq', valueMatchesPagePath: true }]);
    expect(apiRequestShapeOf(inputOf({ url: `${API}/rest/v1/members?id=eq.1` }), { ...CONTEXT, pagePath: '/admin/members/new' }).filters)
      .toEqual([{ name: 'id', operator: 'eq', valueMatchesPagePath: false }]);
  });

  it('keeps the Origin class decided by the caller (the Origin owner), and makes a malformed one or an unreadable URL another', () => {
    expect(apiRequestShapeOf(inputOf({ url: `${OTHER_API}/rest/v1/members`, origin: { kind: 'APPROVED_API', index: 0 } }), CONTEXT).origin)
      .toEqual({ kind: 'APPROVED_API', index: 0 });
    expect(apiRequestShapeOf(inputOf({ url: `${APP}/api/members`, origin: { kind: 'ALLOWED' } }), CONTEXT).origin).toEqual({ kind: 'ALLOWED' });
    expect(apiRequestShapeOf(inputOf({ url: `${ELSEWHERE}/rest/v1/members`, origin: { kind: 'OTHER' } }), CONTEXT).origin).toEqual({ kind: 'OTHER' });
    expect(apiRequestShapeOf(inputOf({ origin: { kind: 'APPROVED_API', index: -1 } }), CONTEXT).origin).toEqual({ kind: 'OTHER' });
    expect(apiRequestShapeOf(inputOf({ url: 'not a url' }), CONTEXT)).toMatchObject({ origin: { kind: 'OTHER' }, pathShape: REDACTED, queryNames: [] });
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
    expect(filtersOf('id=eq.42')).toEqual([{ name: 'id', operator: 'eq', valueMatchesPagePath: true }]);
    expect(filtersOf('id=eq.43')).toEqual([{ name: 'id', operator: 'eq', valueMatchesPagePath: false }]);
    expect(filtersOf('id=eq.members')).toEqual([{ name: 'id', operator: 'eq', valueMatchesPagePath: false }]);
    expect(filtersOf('id=eq.edit')).toEqual([{ name: 'id', operator: 'eq', valueMatchesPagePath: false }]);
    expect(filtersOf('id=neq.42')).toEqual([{ name: 'id', operator: 'OTHER', valueMatchesPagePath: false }]);
    expect(filtersOf('id=42')).toEqual([{ name: 'id', operator: 'OTHER', valueMatchesPagePath: false }]);
    expect(filtersOf(`id=eq.${UUID}`, `/admin/members/${UUID}/edit`)).toEqual([{ name: 'id', operator: 'eq', valueMatchesPagePath: true }]);
    expect(filtersOf('select=*&on_conflict=id')).toEqual([]);
    expect(filtersOf('id=eq.42&email=eq.x')).toEqual([
      { name: 'email', operator: 'eq', valueMatchesPagePath: false },
      { name: 'id', operator: 'eq', valueMatchesPagePath: true },
    ]);
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
  });

  it('records the top-level body form: object, array, scalar JSON, not JSON, none, unreadable', () => {
    const bodyOf = (body: ApiRequestShapeInput['body']) => apiRequestShapeOf(inputOf({ body }), CONTEXT).body;
    const empty = (kind: string) => ({ kind, keys: [], omittedKeyCount: 0, markerKeys: [], stateKeyPresent: false });
    expect(bodyOf(jsonBody([{ name: MARKER_NAME }]))).toEqual(empty('ARRAY'));
    expect(bodyOf(jsonBody(MARKER_NAME))).toEqual(empty('SCALAR'));
    expect(bodyOf({ kind: 'TEXT', text: `name=${MARKER_NAME}` })).toEqual(empty('NOT_JSON'));
    expect(bodyOf({ kind: 'NONE' })).toEqual(empty('NONE'));
    expect(bodyOf({ kind: 'UNREADABLE' })).toEqual(empty('UNREADABLE'));
    expect(bodyOf({ kind: 'TEXT', text: `{"a":"${'x'.repeat(MAX_API_REQUEST_BODY_BYTES)}"}` }).kind).toBe('UNREADABLE');
  });

  it('reads the body only within the byte limit shared with the write stage check (T39R-fix M-5)', () => {
    const bodyOf = (text: string) => apiRequestShapeOf(inputOf({ body: { kind: 'TEXT', text } }), CONTEXT).body.kind;
    expect(MAX_API_REQUEST_BODY_BYTES).toBe(65_536);
    // UTF-8 で 2 bytes の文字: 文字の数は上限の中でも、bytes が上限を超えれば読まない。
    const wrap = (inner: string): string => `{"a":"${inner}"}`;
    const overhead = new TextEncoder().encode(wrap('')).byteLength;
    expect(bodyOf(wrap('é'.repeat(Math.floor((MAX_API_REQUEST_BODY_BYTES - overhead) / 2))))).toBe('OBJECT');
    expect(bodyOf(wrap('é'.repeat(Math.floor((MAX_API_REQUEST_BODY_BYTES - overhead) / 2) + 1)))).toBe('UNREADABLE');
    expect(bodyOf(wrap('x'.repeat(MAX_API_REQUEST_BODY_BYTES - overhead)))).toBe('OBJECT');
    expect(bodyOf(wrap('x'.repeat(MAX_API_REQUEST_BODY_BYTES - overhead + 1)))).toBe('UNREADABLE');
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

  it('hides the names that look like values, are too long, or carry a marker (keys, query names, header names)', () => {
    const longName = 'n'.repeat(MAX_API_SHAPE_NAME_LENGTH + 1);
    const shape = apiRequestShapeOf(inputOf({
      url: `${API}/rest/v1/members?${encodeURIComponent(MARKER_NAME)}=1&${longName}=2&${SECRET_API_KEY}=3`,
      headers: { [`x-${MARKER_NAME}`]: 'v', [longName]: 'v' },
      body: jsonBody({ [MARKER_EMAIL]: 'a', [longName]: 'b', [SECRET_API_KEY]: 'c', ok: MARKER_NAME }),
    }), CONTEXT);
    expect(shape.queryNames).toEqual([REDACTED, REDACTED, REDACTED]);
    expect(shape.headerNames).toEqual([REDACTED, REDACTED]);
    expect(shape.body.keys.map(({ name }) => name)).toEqual([REDACTED, REDACTED, REDACTED, 'ok']);
    expectNoValues(shape);
    expect(JSON.stringify(shape)).not.toContain(longName);
  });

  it('keeps the limits of the body keys, the query names and the header names, and counts the omitted ones', () => {
    const many = (count: number, prefix: string) => Array.from({ length: count }, (_, index) => `${prefix}${String(index).padStart(3, '0')}`);
    const keys = many(MAX_API_SHAPE_BODY_KEYS + 3, 'k');
    const queries = many(MAX_API_SHAPE_QUERY_NAMES + 2, 'q');
    const headers = many(MAX_API_SHAPE_HEADER_NAMES + 4, 'h');
    const shape = apiRequestShapeOf(inputOf({
      url: `${API}/rest/v1/members?${queries.map((name) => `${name}=1`).join('&')}`,
      headers: Object.fromEntries(headers.map((name) => [name, 'v'])),
      body: jsonBody(Object.fromEntries(keys.map((name) => [name, 1]))),
    }), CONTEXT);
    expect(shape.body.keys).toHaveLength(MAX_API_SHAPE_BODY_KEYS);
    expect(shape.body.omittedKeyCount).toBe(3);
    expect(shape.queryNames).toHaveLength(MAX_API_SHAPE_QUERY_NAMES);
    expect(shape.omittedQueryNameCount).toBe(2);
    expect(shape.filters.length).toBeLessThanOrEqual(MAX_API_SHAPE_QUERY_NAMES);
    expect(shape.headerNames).toHaveLength(MAX_API_SHAPE_HEADER_NAMES);
    expect(shape.omittedHeaderNameCount).toBe(4);
  });

  it('rejects too many markers or a marker that is not a string, without the values in the message', () => {
    const tooMany = Array.from({ length: MAX_API_SHAPE_MARKERS + 1 }, (_, index) => `${MARKER_NAME}${String(index)}`);
    expect(() => apiRequestShapeOf(inputOf(), { ...CONTEXT, markers: tooMany })).toThrow(TypeError);
    try {
      apiRequestShapeOf(inputOf(), { ...CONTEXT, markers: tooMany });
    } catch (error) {
      expect(String(error)).not.toContain(MARKER_NAME);
    }
    expect(() => apiRequestShapeOf(inputOf(), { ...CONTEXT, markers: [1 as unknown as string] })).toThrow(TypeError);
  });

  it('does not keep a marker match from a nested value, and matches a number value by its text', () => {
    const shape = apiRequestShapeOf(inputOf({ body: jsonBody({ nested: { name: MARKER_NAME }, count: Number(MARKER_NUMBER) }) }), CONTEXT);
    expect(shape.body.markerKeys).toEqual([{ key: 'count', markers: [2] }]);
    expectNoValues(shape);
  });

  it('normalizes the method and the resource type, and hides an unexpected method', () => {
    expect(apiRequestShapeOf(inputOf({ method: 'post', resourceType: 'xhr' }), CONTEXT)).toMatchObject({ method: 'POST', resourceType: 'xhr' });
    expect(apiRequestShapeOf(inputOf({ method: `X ${SECRET_API_KEY}` }), CONTEXT).method).toBe(REDACTED);
    expect(apiRequestShapeOf(inputOf({ resourceType: 'Fetch Secret' }), CONTEXT).resourceType).toBe('other');
  });
});
