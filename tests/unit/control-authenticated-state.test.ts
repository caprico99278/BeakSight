// T25a（Task 25 の設計書 4.3 の「渡す前に絞る」）: 認証済みの状態の絞り込みの純粋な部品（`filterAuthenticatedState`）の検査。
// - Cookie: ドメインが `approvedTestOrigins` の host と一致するものだけを残す。先頭の `.` は 1 つだけ除いて比べる（同じ host への
//   Domain 属性つきの Cookie は残す）。サブドメイン、親ドメイン（`.example.invalid`）、別の host は残さない。port と scheme は見ない
//   （Cookie は port と scheme で分かれないため）。大文字と小文字は区別しない。
// - T25g-3（独立レビュー T25R の M2）: 残す Domain 属性つきの Cookie は、先頭の `.` を除いて host だけの Cookie にして渡す（サブドメインに
//   送られないように）。ほかの項目と、ドメインの大文字と小文字は変えない。
// - localStorage（`origins`）: `approvedTestOrigins` の Origin（正規の直列化の完全一致）のものだけを残す。
// - 入力を変えない。凍結した写しを返す。値を誤りの文やログに出さない（投げない）。
// 例の値は、匿名の値（`example.invalid`、`127.0.0.1`）だけを使う。
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_LOGIN_STATE_NAME_ROWS,
  authenticatedStateNameRecordOf,
  filterAuthenticatedState,
  type AuthenticatedState,
  type AuthenticatedStateCookie,
} from '../../src/control/auth/authenticated-state.js';

const APP_ORIGIN = 'https://app.example.invalid';
const LOOPBACK_ORIGIN = 'http://127.0.0.1:4173';
const APPROVED = Object.freeze([APP_ORIGIN, LOOPBACK_ORIGIN]);
const SECRET_VALUE = 'cookie-secret-marker-0b7e';

const cookie = (domain: string, name = 'sid', overrides: Partial<AuthenticatedStateCookie> = {}): AuthenticatedStateCookie => ({
  name,
  value: `${SECRET_VALUE}-${name}`,
  domain,
  path: '/',
  expires: -1,
  httpOnly: true,
  secure: true,
  sameSite: 'Lax',
  ...overrides,
});

const stateOf = (cookies: readonly AuthenticatedStateCookie[], origins: AuthenticatedState['origins'] = []): AuthenticatedState => ({
  cookies,
  origins,
});

const domainsOf = (state: AuthenticatedState): readonly string[] => state.cookies.map((entry) => entry.domain);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('T25a: filterAuthenticatedState keeps only the cookies of the approved hosts', () => {
  it('keeps host-only cookies of the approved hosts, regardless of the port', () => {
    const result = filterAuthenticatedState(stateOf([cookie('app.example.invalid'), cookie('127.0.0.1', 'loop')]), APPROVED);
    expect(domainsOf(result)).toEqual(['app.example.invalid', '127.0.0.1']);
    expect(result.cookies[0]).toEqual(cookie('app.example.invalid'));
  });

  it('keeps a domain cookie (leading dot) for exactly an approved host as a host-only cookie (without the leading dot)', () => {
    const result = filterAuthenticatedState(stateOf([cookie('.app.example.invalid'), cookie('.127.0.0.1', 'loop')]), APPROVED);
    expect(domainsOf(result)).toEqual(['app.example.invalid', '127.0.0.1']);
    expect(result.cookies[0]).toEqual(cookie('app.example.invalid'));
    expect(domainsOf(filterAuthenticatedState(stateOf([cookie('.APP.Example.invalid')]), APPROVED))).toEqual(['APP.Example.invalid']);
  });

  // DEF-139（設計書 `2026-10-20-beaksight-login-state-carryover-design.md` 2.2）: 親ドメインの Domain 属性つきの Cookie（`.example.invalid`）は、ブラウザが
  // 許可の host へ送るので、引き継ぐようにした（下の DEF-139 の describe）。ここからは外した（意図した変更）。
  it.each([
    ['the parent domain without a dot (a host-only cookie of the parent)', 'example.invalid'],
    ['a subdomain of an approved host', 'sub.app.example.invalid'],
    ['a subdomain with a leading dot', '.sub.app.example.invalid'],
    ['another host (an IdP)', 'idp.example.invalid'],
    ['a host that only ends with an approved host', 'evilapp.example.invalid'],
    ['two leading dots', '..app.example.invalid'],
    ['a trailing dot', 'app.example.invalid.'],
    ['another loopback address', '127.0.0.2'],
    ['localhost (not approved)', 'localhost'],
    ['an empty domain', ''],
  ])('drops a cookie for %s', (_name, domain) => {
    expect(filterAuthenticatedState(stateOf([cookie(domain)]), APPROVED).cookies).toEqual([]);
  });

  it('compares the domain without letter case', () => {
    expect(domainsOf(filterAuthenticatedState(stateOf([cookie('APP.Example.invalid')]), APPROVED))).toEqual(['APP.Example.invalid']);
  });

  it('keeps the cookies of an IPv6 loopback origin written with or without brackets', () => {
    const result = filterAuthenticatedState(stateOf([cookie('[::1]', 'a'), cookie('::1', 'b')]), ['http://[::1]:4173']);
    expect(result.cookies.map((entry) => entry.name)).toEqual(['a', 'b']);
  });

  it('gives no cookie when no origin is approved, and ignores approved values that are not canonical origins', () => {
    expect(filterAuthenticatedState(stateOf([cookie('app.example.invalid')]), []).cookies).toEqual([]);
    expect(filterAuthenticatedState(stateOf([cookie('app.example.invalid')]), ['https://app.example.invalid/', 'not a url']).cookies)
      .toEqual([]);
  });

  it('keeps the partition key when present, and copies only the known cookie fields', () => {
    const withExtra = { ...cookie('app.example.invalid'), partitionKey: 'https://app.example.invalid', extra: 'x' } as AuthenticatedStateCookie;
    const [kept] = filterAuthenticatedState(stateOf([withExtra]), APPROVED).cookies;
    expect(kept).toEqual({ ...cookie('app.example.invalid'), partitionKey: 'https://app.example.invalid' });
  });

  it('drops a malformed cookie entry instead of throwing', () => {
    const malformed = [null, 1, { domain: 'app.example.invalid' }, { ...cookie('app.example.invalid'), domain: 7 }] as unknown as AuthenticatedStateCookie[];
    expect(filterAuthenticatedState(stateOf([...malformed, cookie('app.example.invalid')]), APPROVED).cookies).toHaveLength(1);
  });
});

describe('T25a: filterAuthenticatedState keeps only the localStorage of the approved origins', () => {
  const storage = (origin: string): AuthenticatedState['origins'][number] => ({
    origin,
    localStorage: [{ name: 'token', value: `${SECRET_VALUE}-${origin}` }],
  });

  it('keeps the approved origins only (exact canonical origin)', () => {
    const result = filterAuthenticatedState(stateOf([], [
      storage(APP_ORIGIN),
      storage('https://sub.app.example.invalid'),
      storage('https://example.invalid'),
      storage('http://app.example.invalid'),
      storage('https://app.example.invalid:8443'),
      storage('http://127.0.0.1:4174'),
      storage(LOOPBACK_ORIGIN),
      storage('https://app.example.invalid/'),
    ]), APPROVED);
    expect(result.origins.map((entry) => entry.origin)).toEqual([APP_ORIGIN, LOOPBACK_ORIGIN]);
    expect(result.origins[0]).toEqual(storage(APP_ORIGIN));
  });

  it('drops a malformed origin entry and malformed storage items instead of throwing', () => {
    const malformed = [
      null,
      { origin: 3, localStorage: [] },
      { origin: APP_ORIGIN, localStorage: 'x' },
      { origin: LOOPBACK_ORIGIN, localStorage: [{ name: 'a', value: 'b' }, { name: 1, value: 'c' }, null] },
    ] as unknown as AuthenticatedState['origins'];
    const result = filterAuthenticatedState(stateOf([], malformed), APPROVED);
    expect(result.origins).toEqual([{ origin: LOOPBACK_ORIGIN, localStorage: [{ name: 'a', value: 'b' }] }]);
  });
});

describe('T25a: filterAuthenticatedState returns a frozen copy and keeps secrets out of logs and errors', () => {
  it('does not change the input, and returns a deeply frozen copy that shares no references', () => {
    const input = stateOf(
      [cookie('app.example.invalid'), cookie('.example.invalid', 'parent')],
      [{ origin: APP_ORIGIN, localStorage: [{ name: 'k', value: 'v' }] }],
    );
    const before = structuredClone(input);
    const result = filterAuthenticatedState(input, APPROVED);
    expect(input).toEqual(before);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.cookies)).toBe(true);
    expect(Object.isFrozen(result.cookies[0])).toBe(true);
    expect(Object.isFrozen(result.origins[0]?.localStorage)).toBe(true);
    expect(Object.isFrozen(result.origins[0]?.localStorage[0])).toBe(true);
    expect(result.cookies[0]).not.toBe(input.cookies[0]);
    expect(result.origins[0]).not.toBe(input.origins[0]);
  });

  it('does not log and does not throw with the values, even for a malformed state', () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    const malformedStates = [
      null,
      {},
      { cookies: 'x', origins: 1 },
      // DEF-139: 親ドメインの Cookie は引き継ぐようになったので、許可の host にドメインとして一致しない Cookie にした。
      { cookies: [cookie('.other.invalid')], origins: [{ origin: 'nope', localStorage: [{ name: 'n', value: SECRET_VALUE }] }] },
    ] as unknown as AuthenticatedState[];
    for (const state of malformedStates) {
      const result = filterAuthenticatedState(state, APPROVED);
      expect(result).toEqual({ cookies: [], origins: [] });
      expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
    }
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});

describe('T25a: filterAuthenticatedState with values that cannot be copied', () => {
  it('returns an empty frozen state for a Proxy that throws, without throwing', () => {
    const throwing = new Proxy({}, { ownKeys: () => { throw new Error('trap'); } }) as unknown as AuthenticatedState;
    const result = filterAuthenticatedState(throwing, APPROVED);
    expect(result).toEqual({ cookies: [], origins: [] });
    expect(Object.isFrozen(result)).toBe(true);
  });
});

// DEF-139（設計書 `2026-10-20-beaksight-login-state-carryover-design.md` 2.2）: ブラウザが許可 Origin か承認したサービスの Origin へ送る Cookie（RFC 6265 の
// domain-match。親ドメインの Domain 属性つきの Cookie を含む）を引き継ぎ、一致した許可の host だけの Cookie に直す。
describe('DEF-139: filterAuthenticatedState carries the cookies that the browser sends to an approved host (domain-match)', () => {
  const SERVICE_ORIGIN = 'https://api.example.invalid';

  it('carries a parent domain cookie as a host-only cookie of the approved host', () => {
    const result = filterAuthenticatedState(stateOf([cookie('.example.invalid', 'parent')]), APPROVED);
    expect(result.cookies).toEqual([cookie('app.example.invalid', 'parent')]);
  });

  it('gives one host-only cookie for each approved or service host that the parent domain matches', () => {
    const result = filterAuthenticatedState(stateOf([cookie('.example.invalid', 'parent')]), APPROVED, [SERVICE_ORIGIN]);
    expect(domainsOf(result)).toEqual(['app.example.invalid', 'api.example.invalid']);
  });

  it('carries a host-only or same-host cookie of an approved service origin as a host-only cookie', () => {
    const result = filterAuthenticatedState(stateOf([cookie('api.example.invalid', 'a'), cookie('.api.example.invalid', 'b')]), APPROVED, [SERVICE_ORIGIN]);
    expect(result.cookies.map(({ name, domain }) => [name, domain])).toEqual([['a', 'api.example.invalid'], ['b', 'api.example.invalid']]);
  });

  it.each([
    ['another subdomain of the parent', '.other.example.invalid'],
    ['a subdomain of an approved host', '.sub.app.example.invalid'],
    ['a single-label domain (a public suffix itself)', '.invalid'],
    ['a single-label domain with an upper case', '.INVALID'],
    ['a domain that only ends with the parent', '.ample.invalid'],
    ['a partial IPv4 address', '.0.0.1'],
    ['an IPv4 address of another host', '.127.0.0.2'],
    ['an IPv6 address of another host', '.::2'],
    ['localhost (not approved)', '.localhost'],
  ])('does not carry a domain cookie of %s', (_name, domain) => {
    expect(filterAuthenticatedState(stateOf([cookie(domain)]), APPROVED, [SERVICE_ORIGIN]).cookies).toEqual([]);
  });

  it('does not carry the domain cookie of the parent of a loopback name (single label), but carries it for the same host', () => {
    expect(filterAuthenticatedState(stateOf([cookie('.localhost')]), ['http://app.localhost:4173']).cookies).toEqual([]);
    expect(domainsOf(filterAuthenticatedState(stateOf([cookie('.localhost')]), ['http://localhost:4173']))).toEqual(['localhost']);
    expect(domainsOf(filterAuthenticatedState(stateOf([cookie('.beak.localhost')]), ['http://app.beak.localhost:4173']))).toEqual(['app.beak.localhost']);
  });

  it('compares the parent domain without letter case, and writes the approved host', () => {
    expect(domainsOf(filterAuthenticatedState(stateOf([cookie('.EXAMPLE.Invalid')]), APPROVED))).toEqual(['app.example.invalid']);
  });

  it('keeps the host-only cookie when a parent domain cookie has the same name and path for the same host', () => {
    const exact = cookie('app.example.invalid', 'sid', { value: `${SECRET_VALUE}-exact` });
    const parent = cookie('.example.invalid', 'sid', { value: `${SECRET_VALUE}-parent` });
    expect(filterAuthenticatedState(stateOf([parent, exact]), APPROVED).cookies).toEqual([exact]);
    // path が違えば、ブラウザはどちらも送るので、どちらも引き継ぐ。
    const parentOtherPath = cookie('.example.invalid', 'sid', { path: '/admin' });
    expect(filterAuthenticatedState(stateOf([exact, parentOtherPath]), APPROVED).cookies).toHaveLength(2);
  });

  it('keeps the cookies of an IPv6 origin only for the exact host (no parent domain for an address)', () => {
    expect(filterAuthenticatedState(stateOf([cookie('.[::1]', 'a')]), ['http://[::1]:4173']).cookies.map(({ name }) => name)).toEqual(['a']);
    expect(filterAuthenticatedState(stateOf([cookie('.1', 'b')]), ['http://[::1]:4173']).cookies).toEqual([]);
  });
});

// DEF-139: 許可 Origin と承認したサービスの Origin の IndexedDB を引き継ぐ（Playwright の `storageState({ indexedDB: true })` の形）。ローカル ストレージは今どおり、
// 許可 Origin のものだけ。
describe('DEF-139: filterAuthenticatedState carries the IndexedDB of the approved and service origins only', () => {
  const SERVICE_ORIGIN = 'https://api.example.invalid';
  const database = (name: string): NonNullable<AuthenticatedState['origins'][number]['indexedDB']>[number] => ({
    name,
    version: 1,
    stores: [{
      name: 'kv',
      autoIncrement: false,
      keyPath: 'id',
      records: [{ value: { id: 'token', secret: `${SECRET_VALUE}-${name}` } }],
      indexes: [],
    }],
  });
  const entry = (origin: string, databases: readonly string[]): AuthenticatedState['origins'][number] => ({
    origin,
    localStorage: [{ name: 'token', value: `${SECRET_VALUE}-ls-${origin}` }],
    indexedDB: databases.map(database),
  });

  it('keeps the IndexedDB of an approved origin with its contents', () => {
    const result = filterAuthenticatedState(stateOf([], [entry(APP_ORIGIN, ['auth-db'])]), APPROVED);
    expect(result.origins).toEqual([entry(APP_ORIGIN, ['auth-db'])]);
    expect(Object.isFrozen(result.origins[0]?.indexedDB?.[0])).toBe(true);
  });

  it('keeps the IndexedDB of an approved service origin without its local storage, and drops other origins', () => {
    const result = filterAuthenticatedState(stateOf([], [
      entry(SERVICE_ORIGIN, ['service-db']),
      entry('https://other.example.invalid', ['other-db']),
      entry('https://app.example.invalid:8443', ['port-db']),
    ]), APPROVED, [SERVICE_ORIGIN]);
    expect(result.origins).toEqual([{ origin: SERVICE_ORIGIN, localStorage: [], indexedDB: [database('service-db')] }]);
  });

  it('does not give an IndexedDB item when an origin has none, and drops a malformed database instead of throwing', () => {
    const malformed = [null, { name: 1, version: 1, stores: [] }, { name: 'x', version: 'v', stores: [] }, { name: 'y', version: 1, stores: 'z' }];
    const result = filterAuthenticatedState(stateOf([], [
      { origin: APP_ORIGIN, localStorage: [], indexedDB: [...malformed, database('ok')] as never },
      { origin: LOOPBACK_ORIGIN, localStorage: [{ name: 'k', value: 'v' }] },
    ]), APPROVED);
    expect(result.origins).toEqual([
      { origin: APP_ORIGIN, localStorage: [], indexedDB: [database('ok')] },
      { origin: LOOPBACK_ORIGIN, localStorage: [{ name: 'k', value: 'v' }] },
    ]);
  });

  it('does not keep an origin of a service origin that has no IndexedDB (its local storage is not carried)', () => {
    const result = filterAuthenticatedState(stateOf([], [{ origin: SERVICE_ORIGIN, localStorage: [{ name: 'k', value: SECRET_VALUE }] }]), APPROVED, [SERVICE_ORIGIN]);
    expect(result.origins).toEqual([]);
  });
});

// DEF-139（設計書 2.1）: ログインの段の終わりの、状態の名前の記録。値を持たない。名前は、ログインの段の観察と同じく、端の一般の語の形（`storageKeyShapeOf`）だけ。
describe('DEF-139: authenticatedStateNameRecordOf records the names and whether each was carried, never a value', () => {
  const SERVICE_ORIGIN = 'https://api.example.invalid';
  const idb = (name: string) => ({ name, version: 1, stores: [{ name: 'kv', autoIncrement: true, records: [{ value: `${SECRET_VALUE}-${name}` }], indexes: [] }] });

  it('records the cookies with the domain, the path, host-only and the outcome, and the storage names by origin', () => {
    const record = authenticatedStateNameRecordOf(stateOf(
      [cookie('app.example.invalid', 'app.session-token'), cookie('.example.invalid', 'auth.jwt'), cookie('idp.example.invalid', 'sid', { path: '/idp' })],
      [
        { origin: APP_ORIGIN, localStorage: [{ name: 'fixture-auth-token', value: SECRET_VALUE }], indexedDB: [idb('auth.token-db')] },
        { origin: 'https://other.example.invalid', localStorage: [{ name: 'other.token', value: SECRET_VALUE }], indexedDB: [idb('other-db')] },
      ],
    ), APPROVED, [SERVICE_ORIGIN]);
    expect(record.cookies).toEqual({
      rows: [
        { domain: 'app.example.invalid', path: '/', hostOnly: true, shape: { prefix: '', suffix: '-token' }, outcome: 'CARRIED', count: 1 },
        { domain: '.example.invalid', path: '/', hostOnly: false, shape: { prefix: '', suffix: '.jwt' }, outcome: 'CARRIED', count: 1 },
        { domain: 'idp.example.invalid', path: '/idp', hostOnly: true, shape: null, outcome: 'OUTSIDE_APPROVED', count: 1 },
      ],
      unlisted: 0,
    });
    expect(record.localStorage).toEqual({
      rows: [
        { origin: APP_ORIGIN, shape: { prefix: '', suffix: '-token' }, outcome: 'CARRIED', count: 1 },
        { origin: 'https://other.example.invalid', shape: { prefix: '', suffix: '.token' }, outcome: 'OUTSIDE_APPROVED', count: 1 },
      ],
      unlisted: 0,
    });
    expect(record.indexedDB).toEqual({
      rows: [
        { origin: APP_ORIGIN, shape: { prefix: 'auth.', suffix: '' }, outcome: 'CARRIED', count: 1 },
        { origin: 'https://other.example.invalid', shape: null, outcome: 'OUTSIDE_APPROVED', count: 1 },
      ],
      unlisted: 0,
    });
    expect(JSON.stringify(record)).not.toContain(SECRET_VALUE);
    expect(Object.isFrozen(record)).toBe(true);
  });

  it('records the local storage of a service origin as not carried (only its IndexedDB is carried)', () => {
    const record = authenticatedStateNameRecordOf(stateOf([], [
      { origin: SERVICE_ORIGIN, localStorage: [{ name: 'k', value: SECRET_VALUE }], indexedDB: [idb('db')] },
    ]), APPROVED, [SERVICE_ORIGIN]);
    expect(record.localStorage.rows.map(({ outcome }) => outcome)).toEqual(['OUTSIDE_APPROVED']);
    expect(record.indexedDB.rows.map(({ outcome }) => outcome)).toEqual(['CARRIED']);
  });

  it('merges the same rows into a count, and keeps only the counts over the named limit', () => {
    const many = Array.from({ length: MAX_LOGIN_STATE_NAME_ROWS + 3 }, (_, index) => cookie(`h${index}.other.invalid`, `n${index}`));
    const record = authenticatedStateNameRecordOf(stateOf([cookie('app.example.invalid', 'a'), cookie('app.example.invalid', 'b'), ...many]), APPROVED);
    expect(record.cookies.rows[0]).toEqual({ domain: 'app.example.invalid', path: '/', hostOnly: true, shape: null, outcome: 'CARRIED', count: 2 });
    expect(record.cookies.rows).toHaveLength(MAX_LOGIN_STATE_NAME_ROWS);
    expect(record.cookies.unlisted).toBe(4);
  });

  it('hides a value-like cookie path, and gives an empty record for a malformed state without throwing', () => {
    const record = authenticatedStateNameRecordOf(stateOf([cookie('app.example.invalid', 'a', { path: `/u/${'a1b2c3d4'.repeat(5)}` })]), APPROVED);
    expect(record.cookies.rows[0]?.path).not.toContain('a1b2c3d4');
    const empty = { rows: [], unlisted: 0 };
    expect(authenticatedStateNameRecordOf(null as unknown as AuthenticatedState, APPROVED)).toEqual({ cookies: empty, localStorage: empty, indexedDB: empty });
  });
});
