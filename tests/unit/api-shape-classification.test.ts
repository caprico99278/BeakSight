// T37b（Task 37 の設計書 3.3 の表、3.4 の `shapeDigest`）: 送らずに観察した型の分類（`src/discovery/api-shape-classification.ts`。純粋な関数）。
// - 上から順に当てる: `NO_REQUEST` → `NOT_EXECUTABLE`（理由の閉じた一覧）→ `API_UPDATE` → `API_CREATE` → `NOT_EXECUTABLE`（`UNRECOGNIZED`）。
// - 型の digest（`shapeDigest`）は、版の印 `beaksight:api-shape/4`（LU-2 の v3 に、DEF-220 の区分 `APPROVED_TEST` を足した版）つきの正規化した型の SHA-256（並びの順によらない）。
// - DEF-220（設計書 `2026-11-08-beaksight-same-origin-api-and-spa-routes-design.md` 3.1）: 承認したテストの Origin の区分（`APPROVED_TEST`）も、承認した API の
//   Origin と同じ規則で分類する（登録・更新になり、DELETE・PUT・手続きの呼び出し・JSON でない本文などは今のとおり止める）。許可 Origin（`ALLOWED`）は今のまま。
import { describe, expect, it } from 'vitest';
import { REDACTED } from '../../src/core/redaction.js';
import { apiRequestShapeOf, type ApiRequestShape, type ApiRequestShapeInput } from '../../src/core/api-request-shape.js';
import {
  API_SHAPE_CLASSIFICATIONS,
  API_SHAPE_DIGEST_FORMAT,
  API_SHAPE_NOT_EXECUTABLE_REASONS,
  apiShapeDigestOf,
  classifyApiShapeObservation,
} from '../../src/discovery/api-shape-classification.js';
import { fieldNameHasStateWord } from '../../src/discovery/classify.js';

const APP = 'https://app.example.test';
const API = 'https://api.example.test';
const PAGE_PATH = '/admin/members/42/edit';

/** テストの Origin の区分（本番は観察の口が Origin の判定の owner で決める）。 */
const originOf = (url: string): ApiRequestShapeInput['origin'] => {
  if (url.startsWith(`${API}/`)) return { kind: 'APPROVED_API', index: 0 };
  return url.startsWith(`${APP}/`) ? { kind: 'ALLOWED' } : { kind: 'OTHER' };
};

const shapeOf = (overrides: Partial<Omit<ApiRequestShapeInput, 'origin'>> = {}, pagePath = PAGE_PATH): ApiRequestShape => {
  const input = {
    method: 'PATCH',
    resourceType: 'fetch',
    url: `${API}/rest/v1/members?id=eq.42`,
    headers: { 'content-type': 'application/json', prefer: 'return=representation' },
    body: { kind: 'TEXT', text: JSON.stringify({ name: 'n', email: 'e', note: 'x' }) } as ApiRequestShapeInput['body'],
    ...overrides,
  };
  // 本番と同じく、論理削除の鍵の判定（伏せる前の名前で見る）を渡す（観察の口が渡す `fieldNameHasStateWord`）。
  return apiRequestShapeOf({ ...input, origin: originOf(input.url) }, { pagePath, markers: [], isStateKeyName: fieldNameHasStateWord });
};

const createShape = (overrides: Partial<Omit<ApiRequestShapeInput, 'origin'>> = {}): ApiRequestShape =>
  shapeOf({ method: 'POST', url: `${API}/rest/v1/members`, ...overrides });

const classify = (shapes: readonly ApiRequestShape[], nonReadRequestCount = shapes.length) =>
  classifyApiShapeObservation({ shapes, nonReadRequestCount });

const classifyFromRow = (shapes: readonly ApiRequestShape[]) =>
  classifyApiShapeObservation({ shapes, nonReadRequestCount: shapes.length, openedFromRow: true });

describe('classifyApiShapeObservation (T37b: the table of the design 3.3)', () => {
  it('keeps the closed lists', () => {
    expect(API_SHAPE_CLASSIFICATIONS).toEqual(['NO_REQUEST', 'NOT_EXECUTABLE', 'API_UPDATE', 'API_CREATE']);
    expect(API_SHAPE_NOT_EXECUTABLE_REASONS).toEqual([
      'DELETE_METHOD', 'PUT_METHOD', 'METHOD_OVERRIDE', 'UNAPPROVED_ORIGIN', 'PROCEDURE_CALL_PATH', 'UPSERT', 'ARRAY_BODY', 'NON_JSON_BODY', 'MULTIPLE_REQUESTS',
      'SOFT_DELETE_KEY', 'SHAPE_TRUNCATED', 'FILTER_MISSING', 'FILTER_MULTIPLE', 'FILTER_NOT_PAGE_VALUE', 'CREATE_PATH_HAS_ID', 'UNRECOGNIZED',
    ]);
  });

  it('is NO_REQUEST when the press sent no non-read request', () => {
    expect(classify([])).toEqual({ classification: 'NO_REQUEST', reason: null, shape: null, shapeDigest: null });
  });

  it('is API_UPDATE for a PATCH to the approved API Origin with one eq filter of the page path value and an object body', () => {
    const shape = shapeOf({ url: `${API}/rest/v1/members?id=eq.42&select=*` });
    expect(classify([shape])).toEqual({ classification: 'API_UPDATE', reason: null, shape, shapeDigest: apiShapeDigestOf(shape) });
  });

  it('is API_CREATE for a POST to the approved API Origin without a filter and with an object body', () => {
    const shape = createShape({ url: `${API}/rest/v1/members?select=*` });
    expect(classify([shape])).toEqual({ classification: 'API_CREATE', reason: null, shape, shapeDigest: apiShapeDigestOf(shape) });
  });

  it.each([
    ['DELETE_METHOD', () => shapeOf({ method: 'DELETE', body: { kind: 'NONE' } })],
    ['PUT_METHOD', () => shapeOf({ method: 'PUT' })],
    ['UNAPPROVED_ORIGIN', () => createShape({ url: 'https://elsewhere.example.test/rest/v1/members' })],
    ['UNAPPROVED_ORIGIN', () => createShape({ url: `${APP}/rest/v1/members` })],
    ['PROCEDURE_CALL_PATH', () => createShape({ url: `${API}/rest/v1/rpc/upsert_member` })],
    ['UPSERT', () => createShape({ headers: { 'content-type': 'application/json', prefer: 'resolution=merge-duplicates' } })],
    ['UPSERT', () => createShape({ url: `${API}/rest/v1/members?on_conflict=id` })],
    ['ARRAY_BODY', () => createShape({ body: { kind: 'TEXT', text: '[{"name":"n"}]' } })],
    ['NON_JSON_BODY', () => createShape({ body: { kind: 'TEXT', text: 'name=n' } })],
    ['SOFT_DELETE_KEY', () => shapeOf({ body: { kind: 'TEXT', text: '{"name":"n","deleted":true}' } })],
    ['SOFT_DELETE_KEY', () => createShape({ body: { kind: 'TEXT', text: '{"name":"n","is_active":false}' } })],
    ['FILTER_MISSING', () => shapeOf({ url: `${API}/rest/v1/members` })],
    // DEF-198（一覧の行の更新の設計書 5.9 の 1）: 画面の番号の filter のほかが名前の重ならない `eq` だけの形は更新になったので（`api-tenant-filter-update.test.ts`）、
    // ほかの filter が `eq` でない形で確かめる。
    ['FILTER_MULTIPLE', () => shapeOf({ url: `${API}/rest/v1/members?id=eq.42&email=neq.x` })],
    ['FILTER_NOT_PAGE_VALUE', () => shapeOf({ url: `${API}/rest/v1/members?id=eq.43` })],
    ['FILTER_NOT_PAGE_VALUE', () => shapeOf({ url: `${API}/rest/v1/members?id=gt.0` })],
    ['UNRECOGNIZED', () => createShape({ url: `${API}/rest/v1/members?id=eq.42` })],
    // filter の書き方: 閉じた一覧（`select`）と upsert の名前（`on_conflict`）のほかの query は、どれも filter として数える。
    ['FILTER_MULTIPLE', () => shapeOf({ url: `${API}/rest/v1/members?id=eq.42&limit=1` })],
    ['UNRECOGNIZED', () => createShape({ body: { kind: 'NONE' } })],
    ['UNRECOGNIZED', () => createShape({ body: { kind: 'UNREADABLE' } })],
    ['UNRECOGNIZED', () => createShape({ body: { kind: 'TEXT', text: '"n"' } })],
    ['UNRECOGNIZED', () => createShape({ method: 'OPTIONS' })],
  ] as const)('is NOT_EXECUTABLE (%s)', (reason, make) => {
    const shape = make();
    expect(classify([shape])).toEqual({ classification: 'NOT_EXECUTABLE', reason, shape, shapeDigest: apiShapeDigestOf(shape) });
  });

  it('is NOT_EXECUTABLE (MULTIPLE_REQUESTS) when one press sent two non-read requests, unless an earlier row applies', () => {
    const first = createShape();
    expect(classify([first, createShape()])).toMatchObject({ classification: 'NOT_EXECUTABLE', reason: 'MULTIPLE_REQUESTS', shape: first });
    const remove = shapeOf({ method: 'DELETE', body: { kind: 'NONE' } });
    expect(classify([first, remove])).toMatchObject({ classification: 'NOT_EXECUTABLE', reason: 'DELETE_METHOD', shape: remove });
    expect(classify([first], 2)).toMatchObject({ classification: 'NOT_EXECUTABLE', reason: 'MULTIPLE_REQUESTS', shape: first });
  });

  it('is NOT_EXECUTABLE (UNRECOGNIZED) without a shape when the non-read request was counted but not recorded', () => {
    expect(classify([], 1)).toEqual({ classification: 'NOT_EXECUTABLE', reason: 'UNRECOGNIZED', shape: null, shapeDigest: null });
  });

  it('does not take a hidden query name as the closed list (select)', () => {
    const shape = { ...shapeOf(), queryNames: ['id', REDACTED] };
    expect(classify([shape])).toMatchObject({ classification: 'NOT_EXECUTABLE', reason: 'UNRECOGNIZED' });
  });
});

// T37R-fix-A（Task 37 の設計書 8 章の T37R の行の I-3・M-1）: 型の分類の取りこぼし。
describe('classifyApiShapeObservation (T37R-fix-A: I-3 and M-1)', () => {
  const bodyOf = (value: Record<string, unknown>): ApiRequestShapeInput['body'] => ({ kind: 'TEXT', text: JSON.stringify(value) });
  const manyKeys = (count: number): Record<string, string> =>
    Object.fromEntries(Array.from({ length: count }, (_, index) => [`a${String(index).padStart(3, '0')}`, 'v']));

  it.each([
    ['a percent-encoded procedure segment', `${API}/%72pc/purge_all`],
    ['a procedure segment with an encoded slash', `${API}/rest/v1/rpc%2Fpurge_all`],
    ['an upper case procedure segment', `${API}/rest/v1/RPC/purge_all`],
    ['a full width procedure segment', `${API}/rest/v1/${encodeURIComponent('ｒｐｃ')}/purge_all`],
    ['a segment that cannot be decoded (the safe side)', `${API}/rest/v1/%E0%A4%A/purge_all`],
  ])('is NOT_EXECUTABLE (PROCEDURE_CALL_PATH) for %s', (_label, url) => {
    expect(classify([createShape({ url })])).toMatchObject({ classification: 'NOT_EXECUTABLE', reason: 'PROCEDURE_CALL_PATH' });
  });

  it('keeps an ordinary path that only contains the letters (not a segment) as a create', () => {
    expect(classify([createShape({ url: `${API}/rest/v1/rpcs_log` })])).toMatchObject({ classification: 'API_CREATE' });
  });

  it('is NOT_EXECUTABLE (SOFT_DELETE_KEY) for a state key after many keys or with a hidden name', () => {
    const many = createShape({ body: bodyOf({ ...manyKeys(64), deleted_at: null }) });
    expect(classify([many])).toMatchObject({ classification: 'NOT_EXECUTABLE', reason: 'SOFT_DELETE_KEY' });
    const hidden = createShape({ body: bodyOf({ name: 'n', deleted_AbCdEfGhIjKlMnOpQrStUv12: true }) });
    expect(hidden.body.keys.map(({ name }) => name)).toEqual([REDACTED, 'name']);
    expect(classify([hidden])).toMatchObject({ classification: 'NOT_EXECUTABLE', reason: 'SOFT_DELETE_KEY' });
  });

  // L13（N25）: 鍵の数と名前の長さでは「分類できない」にしない（前は 65 個目からの切り詰めと 64 文字を超えた名前で SHAPE_TRUNCATED）。
  it('classifies a body with many keys or long key names, and is SHAPE_TRUNCATED only for a hidden key name', () => {
    expect(classify([createShape({ body: bodyOf(manyKeys(65)) })])).toMatchObject({ classification: 'API_CREATE' });
    expect(classify([shapeOf({ body: bodyOf({ name: 'n', [`note_${'x'.repeat(70)}`]: 'v' }) })])).toMatchObject({ classification: 'API_UPDATE' });
    expect(classify([createShape({ body: bodyOf({ name: 'n', AbCdEfGhIjKlMnOpQrStUv12: 'v' }) })]))
      .toMatchObject({ classification: 'NOT_EXECUTABLE', reason: 'SHAPE_TRUNCATED' });
  });

  it('compares the filter value with the last ID-like segment of the page path only (M-1)', () => {
    const page = '/orgs/7/members/1/edit';
    const orgFilter = shapeOf({ url: `${API}/rest/v1/members?org_id=eq.7` }, page);
    expect(orgFilter.filters).toEqual([{ name: 'org_id', operator: 'eq', valueMatchesPagePath: false, valueIsRecordIdLike: true }]);
    expect(classify([orgFilter])).toMatchObject({ classification: 'NOT_EXECUTABLE', reason: 'FILTER_NOT_PAGE_VALUE' });
    expect(classify([shapeOf({ url: `${API}/rest/v1/members?id=eq.1` }, page)])).toMatchObject({ classification: 'API_UPDATE' });
    // 列の名前は見ない（限界。文書に書く）: 最後の ID と同じ値なら、別の列でも `API_UPDATE`。
    expect(classify([shapeOf({ url: `${API}/rest/v1/members?group_no=eq.1` }, page)])).toMatchObject({ classification: 'API_UPDATE' });
  });
});

// T37R2-fix-A（Task 37 の設計書 8 章の最後の行の M-1・M-2）。
describe('classifyApiShapeObservation (T37R2-fix-A: M-1 and M-2)', () => {
  it.each([
    ['a double percent-encoded procedure segment', `${API}/%2572pc/purge`],
    ['a procedure segment with a path parameter', `${API}/rpc;v=1/purge`],
    ['a procedure segment after a dot segment', `${API}/rest/x/../rpc/purge`],
    ['a procedure segment behind repeated slashes and an upper case parameter', `${API}//RPC;Version=2/purge`],
    ['a segment encoded more times than the decode limit (the safe side)', `${API}/%2525252572pc/purge`],
  ])('is NOT_EXECUTABLE (PROCEDURE_CALL_PATH) for %s', (_label, url) => {
    expect(classify([createShape({ url })])).toMatchObject({ classification: 'NOT_EXECUTABLE', reason: 'PROCEDURE_CALL_PATH' });
  });

  // URL-LEN: 長い path も伏せずに型にする（前は 1,024 を超えたら全体を伏せ、SHAPE_TRUNCATED で実行できないとした）。
  it('keeps the whole shape of a long path and classifies it as the short one', () => {
    const shape = createShape({ url: `${API}/${'a/'.repeat(600)}members` });
    expect(shape.pathShape).toBe(`/${'a/'.repeat(600)}members`);
    expect(classify([shape])).toMatchObject({ classification: classify([createShape({ url: `${API}/a/members` })]).classification });
    expect(classify([shape])).not.toMatchObject({ reason: 'SHAPE_TRUNCATED' });
  });

  it.each([
    ['X-HTTP-Method-Override', 'DELETE'],
    ['x-http-method', 'DELETE'],
    ['X-METHOD-OVERRIDE', 'PUT'],
  ])('is NOT_EXECUTABLE (METHOD_OVERRIDE) for the method override header %s', (name, value) => {
    const shape = createShape({ headers: { 'content-type': 'application/json', [name]: value } });
    expect(classify([shape])).toMatchObject({ classification: 'NOT_EXECUTABLE', reason: 'METHOD_OVERRIDE' });
    expect(JSON.stringify(shape)).not.toContain(value);
  });

  it('is NOT_EXECUTABLE (METHOD_OVERRIDE) for the top-level body key _method, also on an update', () => {
    expect(classify([createShape({ body: { kind: 'TEXT', text: '{"name":"n","_method":"DELETE"}' } })]))
      .toMatchObject({ classification: 'NOT_EXECUTABLE', reason: 'METHOD_OVERRIDE' });
    expect(classify([shapeOf({ body: { kind: 'TEXT', text: '{"name":"n","_METHOD":"PUT"}' } })]))
      .toMatchObject({ classification: 'NOT_EXECUTABLE', reason: 'METHOD_OVERRIDE' });
  });

  it('keeps an ordinary create without an override as API_CREATE (control)', () => {
    expect(classify([createShape({ headers: { 'content-type': 'application/json', 'x-request-id': 'r' } })])).toMatchObject({ classification: 'API_CREATE' });
  });

  it('keeps a soft delete key inside a nested object as a known limit (not detected)', () => {
    expect(classify([createShape({ body: { kind: 'TEXT', text: '{"name":"n","meta":{"deleted":true}}' } })])).toMatchObject({ classification: 'API_CREATE' });
  });
});

// T39R-fix（Task 39 の設計書 7 章の T39R の行の M-5）: 書き込みの段の照合が通さない型は、分類でも実行できない。
describe('classifyApiShapeObservation (T39R-fix: M-5)', () => {
  const withPrefer = (prefer: string) => ({ headers: { 'content-type': 'application/json', prefer } });

  it.each([
    ['an item outside the closed list', 'tx=rollback'],
    ['a known item with an item outside the closed list', 'return=representation, count=exact'],
    ['a return item outside the closed list', 'return=everything'],
    ['an item with a parameter', 'return=representation; handling=lenient'],
  ])('is NOT_EXECUTABLE (UNRECOGNIZED) for a Prefer with %s, on a create and an update', (_label, prefer) => {
    expect(classify([createShape(withPrefer(prefer))])).toMatchObject({ classification: 'NOT_EXECUTABLE', reason: 'UNRECOGNIZED' });
    expect(classify([shapeOf(withPrefer(prefer))])).toMatchObject({ classification: 'NOT_EXECUTABLE', reason: 'UNRECOGNIZED' });
  });

  it('keeps the Prefer items of the closed list (return=) executable (control)', () => {
    expect(classify([createShape(withPrefer('Return=Minimal'))])).toMatchObject({ classification: 'API_CREATE' });
    expect(classify([shapeOf(withPrefer('return=representation, return=headers-only'))])).toMatchObject({ classification: 'API_UPDATE' });
    expect(classify([createShape({ headers: { 'content-type': 'application/json' } })])).toMatchObject({ classification: 'API_CREATE' });
  });
});

describe('apiShapeDigestOf (T37b: the shape digest)', () => {
  it('is the SHA-256 of the normalized shape with the version mark', () => {
    expect(API_SHAPE_DIGEST_FORMAT).toBe('beaksight:api-shape/4');
    expect(apiShapeDigestOf(shapeOf())).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it('is stable for the same shape and does not depend on the order of the lists or the keys', () => {
    const shape = shapeOf({ headers: { prefer: 'return=minimal, resolution=ignore-duplicates', 'content-type': 'application/json', apikey: 'x' } });
    const reordered: ApiRequestShape = {
      body: { ...shape.body, keys: [...shape.body.keys].reverse(), markerKeys: [...shape.body.markerKeys].reverse() },
      prefer: [...shape.prefer].reverse(),
      headerNames: [...shape.headerNames].reverse(),
      filters: [...shape.filters].reverse(),
      queryNames: [...shape.queryNames].reverse(),
      omittedHeaderNameCount: shape.omittedHeaderNameCount,
      omittedQueryNameCount: shape.omittedQueryNameCount,
      contentType: shape.contentType,
      pathShape: shape.pathShape,
      origin: shape.origin,
      resourceType: shape.resourceType,
      method: shape.method,
    };
    expect(apiShapeDigestOf(reordered)).toBe(apiShapeDigestOf(shape));
    expect(apiShapeDigestOf(shapeOf())).toBe(apiShapeDigestOf(shapeOf()));
  });

  // T37b fix round 1（設計書 8 章の履歴の (2)）: 要求の種類は、型に記録するが digest に入れない（Chromium の伝え方で変わるため）。
  // Task 38 の設計書 7 章の最後の行（型の digest v2）: ヘッダの名前は、ページが付けた名前（`isPageSuppliedHeaderName`）だけを digest に入れる。
  it('does not change when only the resource type differs', () => {
    const base = apiShapeDigestOf(shapeOf());
    expect(apiShapeDigestOf(shapeOf({ resourceType: 'xhr' }))).toBe(base);
    expect(apiShapeDigestOf({ ...shapeOf(), resourceType: 'other' })).toBe(base);
  });

  it('does not change when only the names the browser supplies differ (digest v2)', () => {
    const base = apiShapeDigestOf(shapeOf());
    expect(apiShapeDigestOf(shapeOf({
      headers: {
        'content-type': 'application/json', prefer: 'return=representation', 'User-Agent': 'x', 'sec-ch-ua': 'y', 'sec-fetch-mode': 'cors', accept: '*/*',
        Origin: 'https://app.example.test', Referer: 'https://app.example.test/',
      },
    }))).toBe(base);
    expect(apiShapeDigestOf({ ...shapeOf(), headerNames: [...shapeOf().headerNames, 'accept-language'] })).toBe(base);
  });

  it('changes when the names the page supplies differ, without depending on the case or the order (digest v2)', () => {
    const base = apiShapeDigestOf(shapeOf());
    const withKey = apiShapeDigestOf(shapeOf({ headers: { 'content-type': 'application/json', prefer: 'return=representation', apikey: 'k' } }));
    expect(withKey).not.toBe(base);
    expect(apiShapeDigestOf(shapeOf({ headers: { 'content-type': 'application/json', prefer: 'return=representation', authorization: 'Bearer t' } })))
      .not.toBe(base);
    expect(apiShapeDigestOf(shapeOf({ headers: { 'content-type': 'application/json' } }))).not.toBe(base);
    expect(apiShapeDigestOf({ ...shapeOf(), headerNames: ['APIKEY', 'Prefer', 'Content-Type'] }))
      .toBe(apiShapeDigestOf({ ...shapeOf(), headerNames: ['apikey', 'content-type', 'prefer'] }));
    expect(apiShapeDigestOf({ ...shapeOf(), headerNames: ['apikey', 'apikey', 'content-type', 'prefer'] }))
      .toBe(apiShapeDigestOf({ ...shapeOf(), headerNames: ['apikey', 'content-type', 'prefer'] }));
  });

  it('changes when an item of the digest changes', () => {
    const base = apiShapeDigestOf(shapeOf());
    const shape = shapeOf();
    const changed: readonly ApiRequestShape[] = [
      shapeOf({ method: 'POST' }),
      { ...shape, origin: { kind: 'APPROVED_API', index: 1 } },
      { ...shape, origin: { kind: 'ALLOWED' } },
      // DEF-220: 承認したテストの Origin の区分は、同じ番号の承認したサービスの Origin と別の型。
      { ...shape, origin: { kind: 'APPROVED_TEST', index: 0 } },
      shapeOf({ url: `${API}/rest/v1/teams?id=eq.42` }),
      shapeOf({ url: `${API}/rest/v1/members?id=eq.42&select=*` }),
      shapeOf({ url: `${API}/rest/v1/members?id=eq.43` }),
      shapeOf({ url: `${API}/rest/v1/members?key=eq.42` }),
      shapeOf({ headers: { 'content-type': 'text/plain', prefer: 'return=representation' } }),
      shapeOf({ headers: { 'content-type': 'application/json', prefer: 'return=minimal' } }),
      shapeOf({ body: { kind: 'TEXT', text: '[{"name":"n"}]' } }),
      shapeOf({ body: { kind: 'TEXT', text: '{"name":1,"email":"e","note":"x"}' } }),
      shapeOf({ body: { kind: 'TEXT', text: '{"name":"n","email":"e","memo":"x"}' } }),
      { ...shape, body: { ...shape.body, markerKeys: [{ key: 'name', markers: [0] }] } },
      { ...shape, body: { ...shape.body, stateKeyPresent: true } },
    ];
    for (const other of changed) {
      expect(apiShapeDigestOf(other)).not.toBe(base);
    }
  });
});

// ARR-1（設計書 `2026-11-08-beaksight-api-array-keys-design.md` 3.2 の 3）: 型の digest に一覧の要素の情報と、一覧の中の印を入れる。一覧の鍵のない型の
// digest は今と同じ値（版の印は上げない。今の承認を無効にしない）。固定の値は ARR-1 の前の実装で計算した値。
describe('apiShapeDigestOf (ARR-1: the elements of an array key)', () => {
  const fixedShapeOf = (body: unknown, markers: readonly string[] = []): ApiRequestShape => apiRequestShapeOf({
    method: 'POST',
    resourceType: 'fetch',
    url: `${API}/rest/v1/members`,
    origin: { kind: 'APPROVED_API', index: 0 },
    headers: { 'content-type': 'application/json', prefer: 'return=representation', 'x-csrf-token': 't' },
    body: { kind: 'TEXT', text: JSON.stringify(body) },
  }, { pagePath: '/admin/members/new', markers, isStateKeyName: fieldNameHasStateWord });

  it('keeps the digest of a shape without an array key (the value computed before ARR-1)', () => {
    expect(API_SHAPE_DIGEST_FORMAT).toBe('beaksight:api-shape/4');
    expect(apiShapeDigestOf(fixedShapeOf({ name: 'mkA1', email: 'e', note: 'x', age: 3, active: true, extra: null, meta: {} }, ['mkA1'])))
      .toBe('sha256:a1b0be9337ea710251ef1a1053cc21c4d8ec0ae0adc7dbde70485913af85e6fb');
  });

  it('changes the digest of a shape with an array key (the element information is in it)', () => {
    expect(apiShapeDigestOf(fixedShapeOf({ name: 'n', tags: ['a'] })))
      .not.toBe('sha256:70353f0c9974d56945ac7171e9f6dc4919c330b20e904101aa41ba14ebe11f4e');
  });

  it('changes when the element types, the count, the nesting or the mark of a marker in an array differ', () => {
    const base = apiShapeDigestOf(fixedShapeOf({ tags: ['a'] }));
    const changed = [
      fixedShapeOf({ tags: [1] }),
      fixedShapeOf({ tags: ['a', 'b'] }),
      fixedShapeOf({ tags: [] }),
      fixedShapeOf({ tags: [{}] }),
      fixedShapeOf({ tags: ['mkB2'] }, ['mkB2']),
    ];
    for (const other of changed) {
      expect(apiShapeDigestOf(other)).not.toBe(base);
    }
    // 値が違うだけ（型・数・印が同じ）なら同じ。L13 fix round 1: 文字の長さの上限はないので、長い文字も同じ。
    expect(apiShapeDigestOf(fixedShapeOf({ tags: ['b'] }))).toBe(base);
    expect(apiShapeDigestOf(fixedShapeOf({ tags: ['x'.repeat(201)] }))).toBe(base);
    const marked = fixedShapeOf({ tags: ['mkB2'] }, ['mkB2']);
    const unmarkedSameKeys: ApiRequestShape = {
      ...marked,
      body: { ...marked.body, markerKeys: marked.body.markerKeys.map(({ key, markers }) => ({ key, markers })) },
    };
    expect(apiShapeDigestOf(unmarkedSameKeys)).not.toBe(apiShapeDigestOf(marked));
  });

  it('does not depend on the order of the element types', () => {
    const shape = fixedShapeOf({ tags: ['a', 1] });
    const reordered: ApiRequestShape = {
      ...shape,
      body: {
        ...shape.body,
        keys: shape.body.keys.map((key) => (key.elements === undefined ? key : { ...key, elements: { ...key.elements, types: [...key.elements.types].reverse() } })),
      },
    };
    expect(apiShapeDigestOf(reordered)).toBe(apiShapeDigestOf(shape));
  });
});

// DEF-147（設計書 `2026-10-21-beaksight-api-state-keys-design.md` 2・3 章の 1）: 公開の状態の鍵（status・is_published・published_at など）だけを持つ型は、
// 論理削除にしない（ほかの決まりで登録・更新を決める）。論理削除の鍵（deleted_at・is_deleted など）は、今どおり `SOFT_DELETE_KEY`。
describe('classifyApiShapeObservation (DEF-147: the publication state keys are not the soft delete keys)', () => {
  const bodyOf = (value: Record<string, unknown>): ApiRequestShapeInput['body'] => ({ kind: 'TEXT', text: JSON.stringify(value) });

  it.each([
    ['status', { title: 't', status: 'draft' }],
    ['is_published', { title: 't', is_published: false }],
    ['published_at', { title: 't', published_at: '2026-10-21T00:00:00Z' }],
    ['status, is_published and published_at', { title: 't', status: 'draft', is_published: false, published_at: null }],
    ['visibility', { title: 't', visibility: 'private' }],
  ])('is API_CREATE for a POST with the publication state key %s', (_label, body) => {
    const shape = createShape({ url: `${API}/rest/v1/notes`, body: bodyOf(body) });
    expect(classify([shape])).toEqual({ classification: 'API_CREATE', reason: null, shape, shapeDigest: apiShapeDigestOf(shape) });
  });

  it('is API_UPDATE for a PATCH whose filter is the ID of the page, with the publication state key status', () => {
    const shape = shapeOf({ url: `${API}/rest/v1/tasks?id=eq.42`, body: bodyOf({ title: 't', status: 'open' }) });
    expect(classify([shape])).toEqual({ classification: 'API_UPDATE', reason: null, shape, shapeDigest: apiShapeDigestOf(shape) });
  });

  it.each([
    ['deleted_at', { title: 't', deleted_at: null }],
    ['is_deleted', { title: 't', is_deleted: false }],
    ['deleted', { title: 't', deleted: false }],
    ['archived', { title: 't', archived: false }],
    ['removed', { title: 't', removed: false }],
    ['trashed', { title: 't', trashed: false }],
    ['a publication key with a soft delete key', { title: 't', status: 'draft', deleted_at: null }],
    // 公開の状態でも論理削除でもない状態の語は、今どおり止める側（fail-closed）。
    ['is_active', { title: 't', is_active: true }],
  ])('is still NOT_EXECUTABLE (SOFT_DELETE_KEY) with %s', (_label, body) => {
    const shape = createShape({ url: `${API}/rest/v1/notes`, body: bodyOf(body) });
    expect(classify([shape])).toMatchObject({ classification: 'NOT_EXECUTABLE', reason: 'SOFT_DELETE_KEY' });
  });

  it('keeps SOFT_DELETE_KEY when the state key flag is not explained by the visible keys', () => {
    const shape = createShape({ body: bodyOf({ name: 'n' }) });
    expect(classify([{ ...shape, body: { ...shape.body, stateKeyPresent: true } }])).toMatchObject({ classification: 'NOT_EXECUTABLE', reason: 'SOFT_DELETE_KEY' });
  });

  it('does not change the shape digest of a shape with a publication state key (the observation flag stays as it was)', () => {
    const shape = createShape({ url: `${API}/rest/v1/notes`, body: bodyOf({ title: 't', status: 'draft' }) });
    expect(shape.body.stateKeyPresent).toBe(true);
  });
});

// LU-2（設計書 `2026-11-02-beaksight-list-row-update-design.md` 5.2 の 3〜5、K4）: 一覧の行から開いた入力の更新（filter・path の番号）と、番号のある送り先への POST。
describe('classifyApiShapeObservation (LU-2: the update from a row of a list)', () => {
  const LIST_PAGE = '/items';
  const itemShape = (method: string, path: string): ApiRequestShape => shapeOf({ method, url: `${API}${path}` }, LIST_PAGE);

  it('is API_UPDATE for a PATCH with one eq filter of a record number only when the input was opened from a row', () => {
    const shape = itemShape('PATCH', '/api/items?id=eq.3');
    expect(classifyFromRow([shape])).toEqual({ classification: 'API_UPDATE', reason: null, shape, shapeDigest: apiShapeDigestOf(shape) });
    // 開き手がない（既定）なら今のまま。
    expect(classify([shape])).toMatchObject({ classification: 'NOT_EXECUTABLE', reason: 'FILTER_NOT_PAGE_VALUE' });
    expect(classifyApiShapeObservation({ shapes: [shape], nonReadRequestCount: 1, openedFromRow: false }))
      .toMatchObject({ classification: 'NOT_EXECUTABLE', reason: 'FILTER_NOT_PAGE_VALUE' });
    expect(classifyFromRow([itemShape('PATCH', '/api/items?id=eq.550e8400-e29b-41d4-a716-446655440000')])).toMatchObject({ classification: 'API_UPDATE' });
  });

  it('does not make an update from a row when the filter value is not a record number, not eq, or not one filter', () => {
    expect(classifyFromRow([itemShape('PATCH', '/api/items?id=eq.abc')])).toMatchObject({ classification: 'NOT_EXECUTABLE', reason: 'FILTER_NOT_PAGE_VALUE' });
    expect(classifyFromRow([itemShape('PATCH', '/api/items?id=gt.3')])).toMatchObject({ classification: 'NOT_EXECUTABLE', reason: 'FILTER_NOT_PAGE_VALUE' });
    expect(classifyFromRow([itemShape('PATCH', '/api/items?id=eq.3&owner=eq.4')])).toMatchObject({ classification: 'NOT_EXECUTABLE', reason: 'FILTER_MULTIPLE' });
    expect(classifyFromRow([itemShape('PATCH', '/api/items')])).toMatchObject({ classification: 'NOT_EXECUTABLE', reason: 'FILTER_MISSING' });
    // 古い型（番号の形の印がない）は、番号の形とみなさない。
    const legacy = itemShape('PATCH', '/api/items?id=eq.3');
    const legacyShape = { ...legacy, filters: legacy.filters.map(({ name, operator, valueMatchesPagePath }) => ({ name, operator, valueMatchesPagePath })) } as unknown as ApiRequestShape;
    expect(classifyFromRow([legacyShape])).toMatchObject({ classification: 'NOT_EXECUTABLE', reason: 'FILTER_NOT_PAGE_VALUE' });
  });

  it('is API_UPDATE for a PATCH without a filter whose path shape ends with {id}', () => {
    const shape = itemShape('PATCH', '/api/items/4');
    expect(shape.pathShape).toBe('/api/items/{id}');
    expect(classify([shape])).toEqual({ classification: 'API_UPDATE', reason: null, shape, shapeDigest: apiShapeDigestOf(shape) });
    expect(classifyFromRow([shape])).toMatchObject({ classification: 'API_UPDATE' });
    // 行ごとに番号が違っても、型と digest は同じ。
    expect(apiShapeDigestOf(itemShape('PATCH', '/api/items/5'))).toBe(apiShapeDigestOf(shape));
    // 途中の番号だけの path は今のまま（filter がない）。
    expect(classify([itemShape('PATCH', '/projects/7/items')])).toMatchObject({ classification: 'NOT_EXECUTABLE', reason: 'FILTER_MISSING' });
    // object でない本文・閉じた一覧の外の query は更新にしない。
    expect(classify([shapeOf({ method: 'PATCH', url: `${API}/api/items/4`, body: { kind: 'NONE' } }, LIST_PAGE)]))
      .toMatchObject({ classification: 'NOT_EXECUTABLE', reason: 'UNRECOGNIZED' });
    expect(classify([itemShape('PATCH', '/api/items/4?select=*')])).toMatchObject({ classification: 'API_UPDATE' });
  });

  it('keeps a PUT not executable (PUT_METHOD), also to a path that ends with a record number', () => {
    expect(classifyFromRow([itemShape('PUT', '/api/items/4')])).toMatchObject({ classification: 'NOT_EXECUTABLE', reason: 'PUT_METHOD' });
    expect(classifyFromRow([itemShape('PUT', '/api/items?id=eq.3')])).toMatchObject({ classification: 'NOT_EXECUTABLE', reason: 'PUT_METHOD' });
  });

  it('is NOT_EXECUTABLE (CREATE_PATH_HAS_ID) for a POST whose path shape ends with {id} (K4)', () => {
    const shape = itemShape('POST', '/api/items/4');
    expect(classify([shape])).toEqual({ classification: 'NOT_EXECUTABLE', reason: 'CREATE_PATH_HAS_ID', shape, shapeDigest: apiShapeDigestOf(shape) });
    expect(classifyFromRow([shape])).toMatchObject({ classification: 'NOT_EXECUTABLE', reason: 'CREATE_PATH_HAS_ID' });
    // 番号のない送り先への POST は今のまま登録。
    expect(classify([itemShape('POST', '/api/items')])).toMatchObject({ classification: 'API_CREATE', reason: null });
    expect(classify([itemShape('POST', '/projects/7/items')])).toMatchObject({ classification: 'API_CREATE', reason: null });
  });
});

describe('DEF-220: the shape to an approved test Origin (APPROVED_TEST)', () => {
  /** 承認したテストの Origin（`approvedTestOrigins` の番号 0）への要求の型。 */
  const testShape = (method: string, path: string, body: ApiRequestShapeInput['body'] = { kind: 'TEXT', text: JSON.stringify({ name: 'n' }) }): ApiRequestShape =>
    apiRequestShapeOf({
      method, resourceType: 'fetch', url: `${APP}${path}`, origin: { kind: 'APPROVED_TEST', index: 0 }, headers: { 'content-type': 'application/json' }, body,
    }, { pagePath: PAGE_PATH, markers: [], isStateKeyName: fieldNameHasStateWord });

  it('is API_CREATE for a POST and API_UPDATE for a PATCH with the filter of the page path value', () => {
    const create = testShape('POST', '/api/members');
    expect(create.origin).toEqual({ kind: 'APPROVED_TEST', index: 0 });
    expect(classify([create])).toEqual({ classification: 'API_CREATE', reason: null, shape: create, shapeDigest: apiShapeDigestOf(create) });
    expect(classify([testShape('PATCH', '/api/members?id=eq.42')])).toMatchObject({ classification: 'API_UPDATE', reason: null });
  });

  it.each([
    ['DELETE_METHOD', () => testShape('DELETE', '/api/members?id=eq.42', { kind: 'NONE' })],
    ['PUT_METHOD', () => testShape('PUT', '/api/members?id=eq.42')],
    ['PROCEDURE_CALL_PATH', () => testShape('POST', '/api/rpc/add_member')],
    ['PROCEDURE_CALL_PATH', () => testShape('POST', '/functions/v1/add-member')],
    ['UPSERT', () => testShape('POST', '/api/members?on_conflict=id')],
    ['ARRAY_BODY', () => testShape('POST', '/api/members', { kind: 'TEXT', text: '[{"name":"n"}]' })],
    ['NON_JSON_BODY', () => testShape('POST', '/api/members', { kind: 'TEXT', text: 'name=n' })],
    ['SOFT_DELETE_KEY', () => testShape('PATCH', '/api/members?id=eq.42', { kind: 'TEXT', text: '{"deleted_at":"x"}' })],
  ] as const)('keeps the rule %s', (reason, make) => {
    expect(classify([make()])).toMatchObject({ classification: 'NOT_EXECUTABLE', reason });
  });

  it('keeps a request to an allowed Origin that is not an approved test Origin not executable (UNAPPROVED_ORIGIN)', () => {
    const allowed = { ...testShape('POST', '/api/members'), origin: { kind: 'ALLOWED' } as const };
    expect(classify([allowed])).toMatchObject({ classification: 'NOT_EXECUTABLE', reason: 'UNAPPROVED_ORIGIN' });
  });
});
