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

  it.each([
    ['the parent domain with a leading dot', '.example.invalid'],
    ['the parent domain without a dot', 'example.invalid'],
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
      { cookies: [cookie('.example.invalid')], origins: [{ origin: 'nope', localStorage: [{ name: 'n', value: SECRET_VALUE }] }] },
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
