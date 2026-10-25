// DEF-139（設計書 `2026-10-20-beaksight-login-state-carryover-design.md` 2.1）: ログインの段の状態の名前の記録の IPC の契約（`AUTH_STATE` の任意の項目
// `loginStateNames`。`src/control/worker-protocol.ts`、`schemas/control/worker-message.schema.json`。任意の項目なので、古いメッセージは今どおり受ける）。
// - Cookie はドメイン・path・host だけか・名前の形・結果・数、ローカル ストレージの鍵と IndexedDB のデータベースは Origin・名前の形・結果・数。値と名前の
//   全体は持たない（名前の形はログインの段の観察と同じ決まり `isLoginObservedStorageKeyShape`）。行は置き場所ごとに上限まで。
// - ログインの段の結果（止めた一覧と同じ状態）だけが持てる。
// 例の値は匿名の値だけ。
import { describe, expect, it } from 'vitest';
import { MAX_LOGIN_STATE_NAME_ROWS } from '../../src/control/auth/authenticated-state.js';
import { REDACTED_PATH_SEGMENT } from '../../src/core/url-path-redaction.js';
import { WORKER_PROTOCOL_VERSION, WORKER_SESSION_LOST_STATE, validateWorkerToParentMessage } from '../../src/control/worker-protocol.js';

const ORIGIN = 'http://127.0.0.1:4173';
const JWT_LIKE = 'eyJtYXJrZXIiOiJ0NDNkIn0.eyJzdWIiOiJleGFtcGxlIn0.bWFya2VyLXNpZ25hdHVyZQ';

const NAMES = Object.freeze({
  cookies: {
    rows: [
      { domain: '.example.invalid', path: '/', hostOnly: false, shape: { prefix: '', suffix: '-token' }, outcome: 'CARRIED', count: 1 },
      { domain: 'idp.example.invalid', path: REDACTED_PATH_SEGMENT, hostOnly: true, shape: null, outcome: 'OUTSIDE_APPROVED', count: 2 },
    ],
    unlisted: 0,
  },
  localStorage: { rows: [{ origin: ORIGIN, shape: { prefix: 'auth.', suffix: '' }, outcome: 'CARRIED', count: 1 }], unlisted: 3 },
  indexedDB: { rows: [{ origin: ORIGIN, shape: null, outcome: 'CARRIED', count: 1 }], unlisted: 0 },
});

const authState = (state: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ protocol: WORKER_PROTOCOL_VERSION, type: 'AUTH_STATE', state, sessionLostUrl: null, ...extra });
const ok = (message: unknown): boolean => validateWorkerToParentMessage(JSON.parse(JSON.stringify(message)) as unknown).ok;
const withNames = (change: (names: typeof NAMES) => unknown, state = 'AUTHENTICATED'): Record<string, unknown> =>
  authState(state, { loginStateNames: change(structuredClone(NAMES) as typeof NAMES) });

describe('DEF-139: loginStateNames in AUTH_STATE', () => {
  it('accepts the name record on the results of the login stage', () => {
    expect(ok(authState('AUTHENTICATED', { loginStateNames: NAMES }))).toBe(true);
    expect(ok(authState('UNSUPPORTED_AUTH_STATE', { loginStateNames: NAMES }))).toBe(true);
    // 古いメッセージ（項目なし）は今どおり受ける。
    expect(ok(authState('AUTHENTICATED'))).toBe(true);
  });

  it('rejects the record on a state that is not a result of the login stage', () => {
    expect(ok({ ...authState(WORKER_SESSION_LOST_STATE, { loginStateNames: NAMES }), sessionLostUrl: `${ORIGIN}/login` })).toBe(false);
  });

  it.each([
    ['a whole name instead of a shape', (names: typeof NAMES) => ({ ...names, cookies: { rows: [{ ...names.cookies.rows[0], shape: { prefix: 'alice-session-', suffix: '' } }], unlisted: 0 } })],
    ['a value', (names: typeof NAMES) => ({ ...names, cookies: { rows: [{ ...names.cookies.rows[0], value: 'x' }], unlisted: 0 } })],
    ['a value-like path', (names: typeof NAMES) => ({ ...names, cookies: { rows: [{ ...names.cookies.rows[0], path: `/s/${JWT_LIKE}` }], unlisted: 0 } })],
    ['a non-canonical origin', (names: typeof NAMES) => ({ ...names, indexedDB: { rows: [{ ...names.indexedDB.rows[0], origin: `${ORIGIN}/` }], unlisted: 0 } })],
    ['an unknown outcome', (names: typeof NAMES) => ({ ...names, indexedDB: { rows: [{ ...names.indexedDB.rows[0], outcome: 'DROPPED' }], unlisted: 0 } })],
    ['a zero count', (names: typeof NAMES) => ({ ...names, localStorage: { rows: [{ ...names.localStorage.rows[0], count: 0 }], unlisted: 0 } })],
    ['too many rows', (names: typeof NAMES) => ({ ...names, indexedDB: { rows: Array.from({ length: MAX_LOGIN_STATE_NAME_ROWS + 1 }, () => names.indexedDB.rows[0]), unlisted: 0 } })],
    ['a missing list', ({ cookies, localStorage }: typeof NAMES) => ({ cookies, localStorage })],
    ['a control character in the domain', (names: typeof NAMES) => ({ ...names, cookies: { rows: [{ ...names.cookies.rows[0], domain: 'a\u0000b' }], unlisted: 0 } })],
  ])('rejects %s', (_name, change) => {
    expect(ok(withNames(change))).toBe(false);
  });
});
