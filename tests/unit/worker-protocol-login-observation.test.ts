// T43d（Task 43 の設計書 3 章、4.4）: 手動のログインで観察したことの IPC の契約（`src/control/worker-protocol.ts`、
// `schemas/control/worker-message.schema.json`。スキーマの版は上げない。任意の項目なので、古いメッセージは今どおり受ける）。
// - 止めた要求の行の任意の項目 `query`: 名前の一覧（値なし。上限 `MAX_LOGIN_OBSERVED_QUERY_NAMES`。値に見える名前は伏せた表記だけ）、一覧に入れなかった
//   名前の数、閉じた一覧の名前（`grant_type`）の決まった形の値。値の名前は名前の一覧にある。同じ Origin・path・種類・理由でも、値が違えば別の行。
// - `AUTH_STATE` の任意の項目 `loginObservation`: 成功の鍵の名前の案（ログインの画面の Origin と、新しく出た鍵の名前。値は持たない）と、成功の画面の
//   セレクタの案（認証の設定として受ける CSS、候補の種類、ログアウトの語の閉じた一覧の語）。止めた一覧と同じ状態だけが持てる。空の観察は拒む。
// 例の値は匿名の値だけ。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_SUCCESS_SELECTOR_LENGTH } from '../../src/control/auth/auth-setup-contracts.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { DISCOVERY_DESTRUCTIVE_WORDS, DISCOVERY_LOGOUT_WORDS } from '../../src/discovery/classification-words.js';
import { REDACTED_PATH_SEGMENT } from '../../src/core/url-path-redaction.js';
import {
  MAX_WORKER_NOTICE_URL_LENGTH,
  WORKER_LOGIN_FAILURE_STATES,
  WORKER_PROTOCOL_VERSION,
  validateWorkerToParentMessage,
} from '../../src/control/worker-protocol.js';
import {
  LOGIN_OBSERVED_QUERY_VALUE_NAMES,
  MAX_LOGIN_OBSERVED_QUERY_NAMES,
  MAX_LOGIN_OBSERVED_QUERY_NAME_LENGTH,
  MAX_LOGIN_OBSERVED_QUERY_VALUE_LENGTH,
  MAX_LOGIN_OBSERVED_KEY_PART_LENGTH,
  MAX_LOGIN_OBSERVED_STORAGE_KEY_NAMES,
  MIN_LOGIN_OBSERVED_KEY_PART_LENGTH,
  SUCCESS_SELECTOR_CANDIDATE_KINDS,
} from '../../src/discovery/login-observation.js';

const SCHEMA = JSON.parse(readFileSync(resolve(process.cwd(), 'schemas', 'control', 'worker-message.schema.json'), 'utf8')) as Record<string, unknown>;

const pointerValue = (document: unknown, pointer: string): unknown =>
  pointer.split('/').slice(1).reduce<unknown>((value, key) =>
    (typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined), document);

const ORIGIN = 'http://127.0.0.1:4173';
const SERVICE_ORIGIN = 'http://127.0.0.1:5173';
const JWT_LIKE = 'eyJtYXJrZXIiOiJ0NDNkIn0.eyJzdWIiOiJleGFtcGxlIn0.bWFya2VyLXNpZ25hdHVyZQ';

const TOKEN_QUERY = Object.freeze({ names: ['grant_type'], omitted: 0, values: [{ name: 'grant_type', value: 'password' }] });
const TOKEN_ROW = Object.freeze({ origin: SERVICE_ORIGIN, path: '/auth/v1/token', resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 1, query: TOKEN_QUERY });
/** T43R-fix の C-1（意図して直した期待）: 鍵の名前は接頭辞と接尾辞の組だけ、セレクタはログアウトの属性の CSS だけ。 */
const OBSERVATION = Object.freeze({
  // T43R2-fix（意図して直した期待）: 一般の語の側だけ（片側は空でよい）。
  storageKeys: { origin: ORIGIN, shapes: [{ prefix: '', suffix: '-token' }], omitted: 0 },
  successSelector: { selector: '#logout', kind: 'LOGOUT_CONTROL', logoutWord: 'logout' },
});
const USER = 'entry-user';

const authState = (state: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ protocol: WORKER_PROTOCOL_VERSION, type: 'AUTH_STATE', state, sessionLostUrl: null, ...extra });
const withRow = (change: Record<string, unknown>): Record<string, unknown> =>
  authState('LOGIN_TIMEOUT', { blockedRequests: { requests: [{ ...TOKEN_ROW, ...change }], unlisted: 0 } });
const withQuery = (change: Record<string, unknown>): Record<string, unknown> => withRow({ query: { ...TOKEN_QUERY, ...change } });
const withObservation = (observation: unknown): Record<string, unknown> => authState('AUTHENTICATED', { loginObservation: observation });

const ok = (message: unknown): boolean => validateWorkerToParentMessage(JSON.parse(JSON.stringify(message)) as unknown).ok;

describe('T43d: the query of a blocked request in AUTH_STATE', () => {
  it('has the query in the schema with the same limits', () => {
    const query = '/$defs/loginStageBlockedRequests/properties/requests/items/properties/query';
    expect(pointerValue(SCHEMA, `${query}/properties/names/maxItems`)).toBe(MAX_LOGIN_OBSERVED_QUERY_NAMES);
    expect(pointerValue(SCHEMA, `${query}/properties/names/items/maxLength`)).toBe(MAX_LOGIN_OBSERVED_QUERY_NAME_LENGTH);
    expect(pointerValue(SCHEMA, `${query}/properties/values/maxItems`)).toBe(LOGIN_OBSERVED_QUERY_VALUE_NAMES.length);
    expect(pointerValue(SCHEMA, `${query}/properties/values/items/properties/name/enum`)).toEqual([...LOGIN_OBSERVED_QUERY_VALUE_NAMES]);
    expect(pointerValue(SCHEMA, `${query}/properties/values/items/properties/value/maxLength`)).toBe(MAX_LOGIN_OBSERVED_QUERY_VALUE_LENGTH);
  });

  it('accepts a row with the query names and the grant_type value, a row without a query, and two rows that differ by the value', () => {
    expect(ok(withRow({}))).toBe(true);
    expect(ok(withRow({ query: undefined }))).toBe(true);
    expect(ok(withQuery({ names: [REDACTED_PATH_SEGMENT, 'grant_type', 'redirect_to'], omitted: 3 }))).toBe(true);
    expect(ok(withQuery({ names: ['redirect_to'], values: [] }))).toBe(true);
    const refresh = { ...TOKEN_ROW, query: { names: ['grant_type'], omitted: 0, values: [{ name: 'grant_type', value: 'refresh_token' }] } };
    expect(ok(authState('LOGIN_TIMEOUT', { blockedRequests: { requests: [TOKEN_ROW, refresh], unlisted: 0 } }))).toBe(true);
  });

  it.each([
    ['too many names', withQuery({ names: Array.from({ length: MAX_LOGIN_OBSERVED_QUERY_NAMES + 1 }, (_, index) => `n${index}`) })],
    ['a value-like name', withQuery({ names: ['grant_type', JWT_LIKE] })],
    ['an empty name', withQuery({ names: ['grant_type', ''] })],
    ['a repeated name', withQuery({ names: ['grant_type', 'grant_type'] })],
    ['a value of a name out of the closed list', withQuery({ names: ['code'], values: [{ name: 'code', value: 'password' }] })],
    ['a value-like value', withQuery({ values: [{ name: 'grant_type', value: JWT_LIKE }] })],
    ['a value with a space', withQuery({ values: [{ name: 'grant_type', value: 'pass word' }] })],
    ['a value of a name not in the names', withQuery({ names: ['redirect_to'] })],
    ['an empty query', withQuery({ names: [], values: [] })],
    ['a negative omitted count', withQuery({ omitted: -1 })],
    ['an unknown item', withQuery({ raw: 'grant_type=password' })],
    ['two same rows with the same value', authState('LOGIN_TIMEOUT', { blockedRequests: { requests: [TOKEN_ROW, TOKEN_ROW], unlisted: 0 } })],
  ] as const)('rejects a row with %s', (_name, message) => {
    expect(ok(message)).toBe(false);
  });
});

describe('T43d: the login observation in AUTH_STATE', () => {
  it('has the observation in the schema with the same limits and lists', () => {
    expect(pointerValue(SCHEMA, '/$defs/authState/properties/loginObservation')).toEqual({ $ref: '#/$defs/loginObservation' });
    expect(pointerValue(SCHEMA, '/$defs/loginObservation/properties/storageKeys/properties/origin/maxLength')).toBe(MAX_WORKER_NOTICE_URL_LENGTH);
    expect(pointerValue(SCHEMA, '/$defs/loginObservation/properties/storageKeys/properties/shapes/maxItems')).toBe(MAX_LOGIN_OBSERVED_STORAGE_KEY_NAMES);
    expect(pointerValue(SCHEMA, '/$defs/loginObservation/properties/storageKeys/properties/shapes/items/properties/prefix/maxLength'))
      .toBe(MAX_LOGIN_OBSERVED_KEY_PART_LENGTH + 1);
    expect(pointerValue(SCHEMA, '/$defs/loginObservation/properties/storageKeys/properties/shapes/items/properties/suffix/minLength'))
      .toBe(0);
    expect(MIN_LOGIN_OBSERVED_KEY_PART_LENGTH).toBe(2);
    expect(pointerValue(SCHEMA, '/$defs/loginObservation/properties/successSelector/properties/selector/maxLength')).toBe(MAX_SUCCESS_SELECTOR_LENGTH);
    expect(pointerValue(SCHEMA, '/$defs/loginObservation/properties/successSelector/properties/kind/enum')).toEqual([...SUCCESS_SELECTOR_CANDIDATE_KINDS]);
    expect(pointerValue(SCHEMA, '/$defs/loginObservation/properties/successSelector/properties/logoutWord/enum')).toEqual([...DISCOVERY_LOGOUT_WORDS]);
  });

  // ログアウトの語の一覧は、既定で読まない危険な語のログアウトの語と、日本語の語。どの語も、発見の危険な語に含まれる（同じ語を別の意味で増やさない）。
  it('keeps the logout words within the default excluded words and the destructive words', () => {
    expect(DISCOVERY_LOGOUT_WORDS.filter((word) => /^[a-z-]+$/u.test(word))).toEqual(DEFAULT_EXCLUDED_URL_WORDS.filter((word) => word.includes('out')));
    expect(DISCOVERY_LOGOUT_WORDS.every((word) => (DISCOVERY_DESTRUCTIVE_WORDS as readonly string[]).includes(word))).toBe(true);
    expect(Object.isFrozen(DISCOVERY_LOGOUT_WORDS)).toBe(true);
  });

  it.each(['AUTHENTICATED', ...WORKER_LOGIN_FAILURE_STATES, 'AWAITING_LOGIN'])('accepts %s with the observation', (state) => {
    expect(ok(authState(state, { loginObservation: OBSERVATION }))).toBe(true);
  });

  it('accepts only the key shapes, only the selector, a link selector, and the discarded count', () => {
    expect(ok(withObservation({ storageKeys: OBSERVATION.storageKeys }))).toBe(true);
    expect(ok(withObservation({ successSelector: OBSERVATION.successSelector }))).toBe(true);
    expect(ok(withObservation({ successSelector: { selector: 'a[href="/menu/logout"]', kind: 'LOGOUT_CONTROL', logoutWord: 'logout' } }))).toBe(true);
    expect(ok(withObservation({ storageKeys: { origin: ORIGIN, shapes: [{ prefix: '', suffix: '.idToken' }, { prefix: 'session:', suffix: '' }, { prefix: 'auth.', suffix: '-jwt' }], omitted: 2 } })))
      .toBe(true);
    expect(ok(withObservation({ credentialDiscarded: 2 }))).toBe(true);
  });

  // T43R-fix の C-1（意図して直した期待）: 名前の全体、利用者の名前の入る CSS、nav の案は持てない。
  it.each([
    ['SESSION_LOST', authState('SESSION_LOST', { sessionLostUrl: `${ORIGIN}/admin`, loginObservation: OBSERVATION })],
    ['an empty observation', withObservation({})],
    ['a zero discarded count', withObservation({ credentialDiscarded: 0 })],
    ['a non-canonical key origin', withObservation({ storageKeys: { ...OBSERVATION.storageKeys, origin: `${ORIGIN}/` } })],
    ['no key shape', withObservation({ storageKeys: { ...OBSERVATION.storageKeys, shapes: [] } })],
    ['the whole key names', withObservation({ storageKeys: { origin: ORIGIN, names: [`LibAuth.x.${USER}.idToken`], omitted: 0 } })],
    ['a prefix with the middle part', withObservation({ storageKeys: { ...OBSERVATION.storageKeys, shapes: [{ prefix: `LibAuth.${USER}.`, suffix: '.idToken' }] } })],
    ['a prefix without a separator', withObservation({ storageKeys: { ...OBSERVATION.storageKeys, shapes: [{ prefix: 'example', suffix: '-token' }] } })],
    ['a value-like part', withObservation({ storageKeys: { ...OBSERVATION.storageKeys, shapes: [{ prefix: `${'a'.repeat(40)}0123.`, suffix: '-token' }] } })],
    ['a repeated shape', withObservation({ storageKeys: { ...OBSERVATION.storageKeys, shapes: [OBSERVATION.storageKeys.shapes[0], OBSERVATION.storageKeys.shapes[0]] } })],
    ['too many shapes', withObservation({
      storageKeys: { ...OBSERVATION.storageKeys, shapes: ['-token', '-auth', '-session', '-jwt', '-access'].map((suffix) => ({ prefix: '', suffix })) },
    })],
    // T43R2-fix: 利用者の名前が端に来る形と、両側とも空の組は持てない。
    ['a user name at the start', withObservation({ storageKeys: { ...OBSERVATION.storageKeys, shapes: [{ prefix: 'entryuser.', suffix: '' }] } })],
    ['a user name at the end', withObservation({ storageKeys: { ...OBSERVATION.storageKeys, shapes: [{ prefix: '', suffix: '.entryuser' }] } })],
    ['an e-mail address part', withObservation({ storageKeys: { ...OBSERVATION.storageKeys, shapes: [{ prefix: 'alice@example.', suffix: ':token' }] } })],
    ['an empty pair', withObservation({ storageKeys: { ...OBSERVATION.storageKeys, shapes: [{ prefix: '', suffix: '' }] } })],
    ['a key value', withObservation({ storageKeys: { ...OBSERVATION.storageKeys, values: ['x'] } })],
    ['a selector that the auth setup does not accept', withObservation({ successSelector: { ...OBSERVATION.successSelector, selector: 'text=ログアウト' } })],
    ['a selector with a line break', withObservation({ successSelector: { ...OBSERVATION.successSelector, selector: '#a\n#b' } })],
    ['a selector with a user name', withObservation({ successSelector: { ...OBSERVATION.successSelector, selector: `#profile-${USER}` } })],
    ['a link selector with a user name', withObservation({ successSelector: { ...OBSERVATION.successSelector, selector: `a[href="/users/${USER}"]` } })],
    ['a navigation selector', withObservation({ successSelector: { selector: 'a[href="/admin"]', kind: 'NAVIGATION', logoutWord: null } })],
    ['a word out of the closed list', withObservation({ successSelector: { ...OBSERVATION.successSelector, logoutWord: 'exit' } })],
    ['a logout control without a word', withObservation({ successSelector: { ...OBSERVATION.successSelector, logoutWord: null } })],
    ['the element text', withObservation({ successSelector: { ...OBSERVATION.successSelector, text: 'ログアウト' } })],
  ] as const)('rejects the observation with %s', (_name, message) => {
    expect(ok(message)).toBe(false);
  });
});

// FM2e（手を減らす段 2 の設計書 3A.4）: 手動のログインの段の始めに検出したログインの 3 つの欄の CSS の案（`loginFields`。欄の値は持たない）。
// 手動のログインの成功（`AUTHENTICATED`。自動ログインの結果なし）だけが持てる。案のない欄は `null`。どれかは案がある。
describe('FM2e: the login field proposals in the login observation', () => {
  const FIELDS = Object.freeze({ username: '#email', password: 'input[name="password"]', submit: 'button[type="submit"]' });
  const AUTOMATED_REPORT = Object.freeze({ result: 'SUCCEEDED', submitted: 'YES', retryAfterUntil: null, formInvalidReason: null });

  it('has the field proposals in the schema with the selector limit', () => {
    for (const field of ['username', 'password', 'submit']) {
      expect(pointerValue(SCHEMA, `/$defs/loginObservation/properties/loginFields/properties/${field}/maxLength`)).toBe(MAX_SUCCESS_SELECTOR_LENGTH);
    }
    expect(pointerValue(SCHEMA, '/$defs/loginObservation/properties/loginFields/required')).toEqual(['username', 'password', 'submit']);
  });

  it('accepts the proposals of the three fields, and of some fields, with the manual login success', () => {
    expect(ok(withObservation({ loginFields: FIELDS }))).toBe(true);
    expect(ok(withObservation({ ...OBSERVATION, loginFields: FIELDS }))).toBe(true);
    expect(ok(withObservation({ loginFields: { ...FIELDS, username: null, submit: null } }))).toBe(true);
  });

  it.each([
    ['no proposal', withObservation({ loginFields: { username: null, password: null, submit: null } })],
    ['a missing field', withObservation({ loginFields: { username: FIELDS.username, password: FIELDS.password } })],
    ['a value', withObservation({ loginFields: { ...FIELDS, value: 'entry-user' } })],
    ['a selector that the auth setup does not accept', withObservation({ loginFields: { ...FIELDS, username: 'text=メール' } })],
    ['a selector with a line break', withObservation({ loginFields: { ...FIELDS, submit: '#a\n#b' } })],
    ['a too long selector', withObservation({ loginFields: { ...FIELDS, username: `#${'a'.repeat(MAX_SUCCESS_SELECTOR_LENGTH)}` } })],
    ['two same selectors', withObservation({ loginFields: { ...FIELDS, submit: FIELDS.username } })],
    ['a login failure', authState('LOGIN_TIMEOUT', { loginObservation: { loginFields: FIELDS } })],
    ['the automated login', authState('AUTHENTICATED', { automatedLogin: AUTOMATED_REPORT, loginObservation: { loginFields: FIELDS } })],
  ] as const)('rejects the field proposals with %s', (_name, message) => {
    expect(ok(message)).toBe(false);
  });
});
