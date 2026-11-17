// DEF-233（設計書 `doc/design/2026-11-09-beaksight-discovery-token-refresh-design.md` 2.2）: 押した後に更新された、ログインの鍵だけを次の画面へ渡す。
// - 次の画面へ渡す状態は、押す前に読んだもの（T37R-fix-B）を基にし、ログインの成功の鍵（接頭と接尾の決まり）に当たる値だけを置き換える
//   （`withSessionKeyValuesOf`）。押下でページが書いた storage と Cookie は渡さない。
// - 成功の鍵の決まりは、ログインの段の成功の判定と同じ部品（`isSuccessStorageKeyName`。`hasSuccessStorageKey` もこれを使う）。
// - DEF-251（案 1）: 置き換える値は、押す前の値の構造に、凍結の段に通した最後の更新の応答の値を同じ道で当てはめたもの（`sessionKeyValueRebuiltFrom`）。
//   ページが閉じる前に書いた値は使わない。
import { describe, expect, it } from 'vitest';
import { withSessionKeyValuesOf } from '../../src/browser/context-factory.js';
import { issuedSessionValuesOf, sessionKeyValueRebuiltFrom, stringLeavesOf } from '../../src/core/session-key-values.js';
import type { AuthenticatedStorageState } from '../../src/core/authenticated-storage-state.js';
import { hasSuccessStorageKey, isSuccessStorageKeyName } from '../../src/worker/login-stage-checks.js';

const APP = 'https://app.example.test';
const OTHER = 'https://other.example.test';
const KEY = { origin: APP, prefix: 'fixture', suffix: '-auth-token' } as const;
const isKey = (origin: string, name: string): boolean => isSuccessStorageKeyName(origin, name, KEY);

const cookie = (value: string) => ({ name: 'sid', value, domain: 'app.example.test', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' as const });

const PINNED: AuthenticatedStorageState = {
  cookies: [cookie('before')],
  origins: [
    { origin: APP, localStorage: [{ name: 'fixture-auth-token', value: 'old-session' }, { name: 'draft', value: 'before' }] },
    { origin: OTHER, localStorage: [{ name: 'fixture-auth-token', value: 'other-old' }] },
  ],
};

describe('DEF-233 A2: isSuccessStorageKeyName', () => {
  it('is the success key shape of the profile (the same rule as hasSuccessStorageKey)', () => {
    expect(isKey(APP, 'fixture-auth-token')).toBe(true);
    expect(isKey(APP, 'fixture-x-auth-token')).toBe(true);
    expect(isKey(APP, 'draft')).toBe(false);
    expect(isKey(OTHER, 'fixture-auth-token')).toBe(false);
    // 接頭と接尾が重なる名前は当たらない（今の決まり）。
    expect(isSuccessStorageKeyName(APP, 'ab', { origin: APP, prefix: 'ab', suffix: 'b' })).toBe(false);
    expect(hasSuccessStorageKey(PINNED, KEY)).toBe(true);
  });
});

describe('DEF-233 A2: withSessionKeyValuesOf', () => {
  it('replaces only the success key values of the state read before the press with the rebuilt values (DEF-251: the page state before close is not read)', () => {
    const rebuilt = withSessionKeyValuesOf(PINNED, isKey, (before) => (before === 'old-session' ? 'rebuilt-session' : null));
    expect(rebuilt).toEqual({
      cookies: [cookie('before')],
      origins: [
        { origin: APP, localStorage: [{ name: 'fixture-auth-token', value: 'rebuilt-session' }, { name: 'draft', value: 'before' }] },
        { origin: OTHER, localStorage: [{ name: 'fixture-auth-token', value: 'other-old' }] },
      ],
    });
  });

  it('returns the pinned state as it is without the key rule or without a rebuilt value', () => {
    expect(withSessionKeyValuesOf(PINNED, undefined, () => 'rebuilt')).toEqual(PINNED);
    expect(withSessionKeyValuesOf(PINNED, isKey, () => null)).toEqual(PINNED);
  });
});

// DEF-251（案 1）: 次の画面の成功の鍵は、押す前の値の構造に、凍結の段に通した最後の更新の応答の値を、同じ道で当てはめて作る（ページが書いた値は使わない）。
describe('DEF-251: sessionKeyValueRebuiltFrom (the pinned structure with the values of the last refresh response)', () => {
  const RESPONSE = { access_token: 'aNewAccess01', refresh_token: 'rNewRefresh01', expires_at_ms: 2 };
  const issued = issuedSessionValuesOf([JSON.stringify(RESPONSE)]);
  const parsed = (value: string | null): unknown => (value === null ? null : JSON.parse(value));

  it('puts the response values on the same paths of the pinned value, whatever the press wrote into the key (a)', () => {
    const before = JSON.stringify({ access_token: 'aOldAccess00', refresh_token: 'rOldRefresh00', expires_at_ms: 1, token_type: 'bearer' });
    // 押下でページが書き足した鍵の名前・数・文字列は、押す前の値にないので入らない（ページが閉じる前に書いた値は読まない）。
    expect(parsed(sessionKeyValueRebuiltFrom(before, issued))).toEqual({ ...RESPONSE, token_type: 'bearer' });
  });

  it('keeps what the response does not have and leaves a pinned value of another structure as it is (b)', () => {
    // 押す前の値にあって応答にない欄（SDK や、凍結の前にページが書いた欄）、null の欄、型の違う欄、押す前の値の配列は、押す前のまま。
    const before = JSON.stringify({ access_token: 'aOldAccess00', refresh_token: 'rOldRefresh00', expires_at_ms: '1', cb: { a: 'a' }, user: null, bits: ['x'] });
    expect(parsed(sessionKeyValueRebuiltFrom(before, issued)))
      .toEqual({ access_token: 'aNewAccess01', refresh_token: 'rNewRefresh01', expires_at_ms: '1', cb: { a: 'a' }, user: null, bits: ['x'] });
    // 応答の道と押す前の値の道が違う形（入れ子）・JSON でない値・応答のない値は、当てはめない（押す前の値のまま）。
    expect(sessionKeyValueRebuiltFrom(JSON.stringify({ currentSession: { access_token: 'aOldAccess00' } }), issued)).toBeNull();
    expect(sessionKeyValueRebuiltFrom('aOldAccess00', issued)).toBeNull();
    expect(sessionKeyValueRebuiltFrom(JSON.stringify({ access_token: 'aOldAccess00' }), issuedSessionValuesOf([]))).toBeNull();
    // 文字列が 1 つも変わらない（数だけ）なら、当てはめない。
    expect(sessionKeyValueRebuiltFrom(JSON.stringify({ access_token: 'aNewAccess01', expires_at_ms: 1 }), issued)).toBeNull();
  });

  it('uses one response only: the values of two responses are not mixed on one path (c)', () => {
    const before = JSON.stringify({ access_token: 'aOldAccess00', refresh_token: 'rOldRefresh00' });
    const two = issuedSessionValuesOf([JSON.stringify({ access_token: 'aFirst', refresh_token: 'rFirst' }), JSON.stringify(RESPONSE)]);
    expect(sessionKeyValueRebuiltFrom(before, two)).toBeNull();
  });

  it('reads the string leaves of JSON and takes a text that is not JSON as one leaf', () => {
    expect(stringLeavesOf(JSON.stringify({ a: 'x', b: [{ c: 'y' }, 1, true, null] }))).toEqual(['x', 'y']);
    expect(stringLeavesOf('plain-token')).toEqual(['plain-token']);
  });
});
