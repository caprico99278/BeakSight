// T25d（Task 25 の設計書 4.4）: 認証つきの監査の IPC の契約（`src/control/worker-protocol.ts`、`schemas/control/worker-message.schema.json`）。
// - 認証つきの `START`（認証の設定の文書、`approvedTestOrigins`、その SHA-256）と、子 → 親の `AUTH_STATE` の正しい形が通る。
// - 形の違う値（未知の状態、余分な項目、URL の有無の取り違え、許可 Origin の外のログインの画面、正規でない Origin、SHA-256 の形）を拒む。
// - SHA-256 は、鍵の順によらず同じ内容なら同じ値で、内容が変われば違う値になる（ワーカーが比べて `AUTH_SETUP_CHANGED` にする）。
// - 値の一覧（状態、失敗の理由）と上限が、スキーマと一致する。
// 例の値は、匿名の値（`127.0.0.1`、`example`）だけを使う。秘密（Cookie、パスワード）は契約に現れない。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUTH_SETUP_SCHEMA_VERSION_3,
  AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  type AuthSetup,
} from '../../src/control/auth/auth-setup-contracts.js';
import { FORM_NAVIGATION_SETUP_ITEMS, previousVersionSetupDocumentOf } from '../helpers/auth-setup-samples.js';
import {
  MAX_WORKER_APPROVED_SERVICE_ORIGINS,
  MAX_WORKER_APPROVED_TEST_ORIGINS,
  MAX_WORKER_NOTICE_URL_LENGTH,
  WORKER_AUTHENTICATION_SHA256_PATTERN,
  WORKER_AUTH_STATES,
  WORKER_FAILURE_REASONS,
  WORKER_LOGIN_FAILURE_STATES,
  WORKER_PROTOCOL_VERSION,
  WORKER_SESSION_LOST_STATE,
  targetConfigDigestOf,
  validateParentToWorkerMessage,
  validateWorkerToParentMessage,
  workerAuthenticationDigestOf,
} from '../../src/control/worker-protocol.js';
import { MAX_APPROVED_SERVICE_ORIGINS } from '../../src/control/contracts.js';

const SCHEMA = JSON.parse(readFileSync(resolve(process.cwd(), 'schemas', 'control', 'worker-message.schema.json'), 'utf8')) as Record<string, unknown>;

const pointerValue = (document: unknown, pointer: string): unknown =>
  pointer.split('/').slice(1).reduce<unknown>((value, key) =>
    (typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined), document);

const ORIGIN = 'http://127.0.0.1:4173';
const OTHER_ORIGIN = 'http://localhost:4173';
const SHA256 = targetConfigDigestOf(new TextEncoder().encode('{}'));

const SETUP: AuthSetup = Object.freeze({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: 'example-auth',
  profileRevision: 1,
  loginStartUrl: `${ORIGIN}/login`,
  loginPostEndpoints: [{ origin: ORIGIN, path: '/login' }],
  successCondition: { pathPrefix: '/admin', selector: null },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: ['/admin/logout'],
  auditPathPrefixes: ['/admin'],
  maxLoginAttempts: 2,
  allowedIdpOrigins: [],
  automatedLogin: null,
});

/** 自動ログインの設定を持つ設定（T26b。秘密を含まない）。 */
const AUTOMATED_SETUP: AuthSetup = Object.freeze({
  ...SETUP,
  maxLoginAttempts: AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  automatedLogin: {
    usernameSelector: '#username',
    passwordSelector: '#password',
    submitSelector: '#login-submit',
    failureConditions: {
      invalidCredentials: { pathPrefix: '/login', selector: '.login-error' },
      accountLocked: null,
      mfaRequired: null,
      credentialExpired: null,
    },
  },
});

/** 版 1・版 2 の文書（`START` で受けない。LG-3b で版 2 も受けなくなった）。 */
const V1_SETUP = previousVersionSetupDocumentOf(SETUP, 1);
const V2_SETUP = previousVersionSetupDocumentOf(SETUP, 2);

/** T26d-2: 手動のログインの監査の、SHA-256 に含める項目（ジョブの種類と、自動ログインの指定なし）。 */
const MANUAL_BINDING = Object.freeze({ jobKind: 'AUDIT', automatedLogin: null } as const);

/** T26d-2: 自動ログインの指定（資格情報の改訂の番号と、資格情報のフォルダを決める根。秘密でない）。 */
const AUTOMATED_LOGIN = Object.freeze({ credentialRevision: 1, credentialRoot: resolve(process.cwd(), 'example-root') });

const authenticationOf = (setup: AuthSetup = SETUP, approvedTestOrigins: readonly string[] = [ORIGIN]) => ({
  setup,
  approvedTestOrigins,
  authenticationSha256: workerAuthenticationDigestOf(setup, approvedTestOrigins, MANUAL_BINDING),
});

const startWith = (authentication: unknown): Record<string, unknown> => ({
  protocol: WORKER_PROTOCOL_VERSION,
  type: 'START',
  jobId: 'job-0001',
  jobKind: 'AUDIT',
  targetConfigPath: 'local/targets/example-test.json',
  startNew: false,
  targetConfigSha256: SHA256,
  authentication,
});

const authState = (state: string, sessionLostUrl: string | null): Record<string, unknown> =>
  ({ protocol: WORKER_PROTOCOL_VERSION, type: 'AUTH_STATE', state, sessionLostUrl });

describe('worker protocol (T25d): the authenticated START', () => {
  it('accepts an authenticated START, and returns a deeply frozen copy', () => {
    const message = startWith(authenticationOf());
    const result = validateParentToWorkerMessage(message);
    expect(result).toEqual({ ok: true, message });
    if (result.ok && result.message.type === 'START') {
      expect(Object.isFrozen(result.message.authentication?.setup.loginPostEndpoints[0])).toBe(true);
      expect(Object.isFrozen(result.message.authentication?.approvedTestOrigins)).toBe(true);
    }
  });

  it('accepts an authenticated START whose setup has the automated login setup (version 2, T26b)', () => {
    // T26d-2: 自動ログインの設定の `START` は、自動ログインの指定（`automatedLogin`）を必ず持つ（ないものは
    // `worker-protocol-automated-login.test.ts` で拒むことを確かめる）。
    const message = startWith({
      setup: AUTOMATED_SETUP,
      approvedTestOrigins: [ORIGIN],
      authenticationSha256: workerAuthenticationDigestOf(AUTOMATED_SETUP, [ORIGIN], { jobKind: 'AUDIT', automatedLogin: AUTOMATED_LOGIN }),
      automatedLogin: AUTOMATED_LOGIN,
    });
    expect(validateParentToWorkerMessage(message)).toEqual({ ok: true, message });
  });

  it('still accepts a START without authentication (the public audit)', () => {
    const message = startWith(undefined);
    delete message['authentication'];
    expect(validateParentToWorkerMessage(message).ok).toBe(true);
  });

  it.each([
    ['null authentication', null],
    ['authentication without the digest', { setup: SETUP, approvedTestOrigins: [ORIGIN] }],
    ['an extra property on authentication', { ...authenticationOf(), cookies: [] }],
    ['a setup with an extra property (a password)', authenticationOf({ ...SETUP, password: 'x' } as unknown as AuthSetup)],
    ['a setup that is not an auth setup', { ...authenticationOf(), setup: { schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3 } }],
    // T26b・LG-3b: 版 1・版 2 の文書は `START` で受けない（親は版 3 の設定だけを渡す）。
    ['a version 1 setup', authenticationOf(V1_SETUP as unknown as AuthSetup)],
    ['a version 2 setup', authenticationOf(V2_SETUP as unknown as AuthSetup)],
    ['a setup without automatedLogin', authenticationOf((() => {
      const { automatedLogin: _omitted, ...rest } = SETUP;
      return rest as unknown as AuthSetup;
    })())],
    ['no approved origins', authenticationOf(SETUP, [])],
    ['an approved origin that is not canonical', authenticationOf(SETUP, [`${ORIGIN}/`])],
    ['an approved origin that is not http(s)', authenticationOf(SETUP, ['ftp://127.0.0.1'])],
    ['duplicated approved origins', authenticationOf(SETUP, [ORIGIN, ORIGIN])],
    ['too many approved origins', authenticationOf(SETUP, Array.from({ length: MAX_WORKER_APPROVED_TEST_ORIGINS + 1 }, (_, index) => `http://127.0.0.${index % 250}:${1000 + index}`))],
    ['a login page outside the approved origins', authenticationOf({ ...SETUP, loginStartUrl: `${OTHER_ORIGIN}/login` })],
    ['a login endpoint outside the approved origins', authenticationOf({ ...SETUP, loginPostEndpoints: [{ origin: OTHER_ORIGIN, path: '/login' }] })],
    ['a digest in upper case', { ...authenticationOf(), authenticationSha256: SHA256.toUpperCase() }],
    ['a digest that is too short', { ...authenticationOf(), authenticationSha256: SHA256.slice(1) }],
  ] as const)('rejects an authenticated START with %s', (_name, authentication) => {
    expect(validateParentToWorkerMessage(startWith(authentication)).ok).toBe(false);
  });

  it('computes the same digest for the same contents in another key order, and another digest for other contents', () => {
    const reordered = Object.fromEntries(Object.entries(SETUP).reverse()) as unknown as AuthSetup;
    expect(workerAuthenticationDigestOf(reordered, [ORIGIN], MANUAL_BINDING)).toBe(workerAuthenticationDigestOf(SETUP, [ORIGIN], MANUAL_BINDING));
    expect(WORKER_AUTHENTICATION_SHA256_PATTERN.test(workerAuthenticationDigestOf(SETUP, [ORIGIN], MANUAL_BINDING))).toBe(true);
    expect(workerAuthenticationDigestOf({ ...SETUP, maxLoginAttempts: 1 }, [ORIGIN], MANUAL_BINDING))
      .not.toBe(workerAuthenticationDigestOf(SETUP, [ORIGIN], MANUAL_BINDING));
    expect(workerAuthenticationDigestOf(SETUP, [ORIGIN, OTHER_ORIGIN], MANUAL_BINDING)).not.toBe(workerAuthenticationDigestOf(SETUP, [ORIGIN], MANUAL_BINDING));
    // 契約の形は、SHA-256 と文書の一致を確かめない（ワーカーが求め直して比べ、違えば `AUTH_SETUP_CHANGED` にする）。
    expect(validateParentToWorkerMessage(startWith({ ...authenticationOf(), authenticationSha256: SHA256 })).ok).toBe(true);
  });
});

describe('worker protocol (T25d): AUTH_STATE', () => {
  // T26d-2: `AUTOMATED_LOGIN_FAILED` は、自動ログインの結果を必ず持つ（`worker-protocol-automated-login.test.ts`）。
  it.each(WORKER_AUTH_STATES.filter((state) => state !== WORKER_SESSION_LOST_STATE && state !== 'AUTOMATED_LOGIN_FAILED'))('accepts %s without a URL', (state) => {
    const message = authState(state, null);
    expect(validateWorkerToParentMessage(message)).toEqual({ ok: true, message });
  });

  it('accepts SESSION_LOST with the URL of the page, up to the limit', () => {
    for (const url of [`${ORIGIN}/admin/second`, 'u'.repeat(MAX_WORKER_NOTICE_URL_LENGTH)]) {
      const message = authState(WORKER_SESSION_LOST_STATE, url);
      expect(validateWorkerToParentMessage(message)).toEqual({ ok: true, message });
    }
  });

  it.each([
    ['an unknown state', authState('LOGGED_IN', null)],
    ['SESSION_LOST without a URL', authState(WORKER_SESSION_LOST_STATE, null)],
    ['AUTHENTICATED with a URL', authState('AUTHENTICATED', `${ORIGIN}/admin`)],
    ['a URL that is too long', authState(WORKER_SESSION_LOST_STATE, 'u'.repeat(MAX_WORKER_NOTICE_URL_LENGTH + 1))],
    ['a URL with a line break', authState(WORKER_SESSION_LOST_STATE, `${ORIGIN}/a\nb`)],
    ['a URL with a lone surrogate', authState(WORKER_SESSION_LOST_STATE, `${ORIGIN}/\ud800`)],
    ['an empty URL', authState(WORKER_SESSION_LOST_STATE, '')],
    ['an extra property (a cookie)', { ...authState('AUTHENTICATED', null), cookie: 'sid=x' }],
    ['no sessionLostUrl', { protocol: WORKER_PROTOCOL_VERSION, type: 'AUTH_STATE', state: 'AUTHENTICATED' }],
  ] as const)('rejects AUTH_STATE with %s', (_name, value) => {
    expect(validateWorkerToParentMessage(value).ok).toBe(false);
  });

  it('is not a message from the parent', () => {
    expect(validateParentToWorkerMessage(authState('AUTHENTICATED', null)).ok).toBe(false);
  });
});

describe('worker protocol (T25d): value lists and the schema', () => {
  it('has the auth states of the schema, and the login failures are auth states and failure reasons', () => {
    expect(pointerValue(SCHEMA, '/$defs/authState/properties/state/enum')).toEqual([...WORKER_AUTH_STATES]);
    expect(WORKER_LOGIN_FAILURE_STATES.every((state) => (WORKER_AUTH_STATES as readonly string[]).includes(state))).toBe(true);
    // T26d-2: ログインの段の終わり方の後ろに、自動ログインの成功以外の結果を足した（`worker-protocol-automated-login.test.ts`）。
    const loginFailuresAt = WORKER_FAILURE_REASONS.indexOf(WORKER_LOGIN_FAILURE_STATES[0]);
    expect(WORKER_FAILURE_REASONS.slice(loginFailuresAt, loginFailuresAt + WORKER_LOGIN_FAILURE_STATES.length)).toEqual([...WORKER_LOGIN_FAILURE_STATES]);
    expect(WORKER_FAILURE_REASONS).toContain('AUTH_SETUP_CHANGED');
    expect(pointerValue(SCHEMA, '/$defs/failed/properties/reason/enum')).toEqual([...WORKER_FAILURE_REASONS]);
    for (const list of [WORKER_AUTH_STATES, WORKER_LOGIN_FAILURE_STATES]) {
      expect(Object.isFrozen(list)).toBe(true);
    }
  });

  it('has the limits and the patterns of the schema', () => {
    expect(pointerValue(SCHEMA, '/$defs/authState/properties/sessionLostUrl/anyOf/0/maxLength')).toBe(MAX_WORKER_NOTICE_URL_LENGTH);
    expect(pointerValue(SCHEMA, '/$defs/startAuthentication/properties/authenticationSha256/pattern')).toBe(WORKER_AUTHENTICATION_SHA256_PATTERN.source);
    expect(pointerValue(SCHEMA, '/$defs/startAuthentication/properties/approvedTestOrigins/maxItems')).toBe(MAX_WORKER_APPROVED_TEST_ORIGINS);
    // T26b・LG-3b: `START` の認証の設定は版 3 だけ（親と子は同じビルドなので、前の版との互換は要らない）。サービスの Origin の上限は、プロファイルの
    // 上限と同じ。
    expect(pointerValue(SCHEMA, '/$defs/startAuthentication/properties/setup')).toEqual({ $ref: 'urn:beaksight:schema:control:auth-setup:3' });
    expect(pointerValue(SCHEMA, '/$defs/startAuthentication/properties/approvedServiceOrigins/maxItems')).toBe(MAX_WORKER_APPROVED_SERVICE_ORIGINS);
  });
});

// T34a（Task 34 の設計書 3.2）: 認証の設定の版 3 の `START`。認証の指定に、プロファイルの承認したサービスの Origin（`approvedServiceOrigins`。
// 任意。ないときは空と同じ）を足した。契約は、スクリプトの送信先の Origin がサービスの Origin のどれか、ログインに伴う送信の Origin が承認したテストの
// Origin かサービスの Origin、成功のローカル ストレージの鍵の Origin が承認したテストの Origin、であることを確かめる。版 2 の `START` の形と SHA-256 は
// 変わらない（サービスの Origin は SHA-256 に入れない。ワーカーが求め直す値は今のまま）。
describe('worker protocol (T34a): the authenticated START with an auth setup of version 3', () => {
  const SERVICE_ORIGIN = 'http://127.0.0.1:5173';
  const SCRIPT_SETUP: AuthSetup = Object.freeze({
    ...SETUP,
    schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
    loginPostEndpoints: [],
    loginTransport: 'SCRIPT_REQUEST',
    scriptLogin: { origin: SERVICE_ORIGIN, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },
    loginSideRequests: [
      { origin: SERVICE_ORIGIN, path: '/rest/v1/rpc/resolve', method: 'POST', maxPerLoginStage: 1 },
      { origin: ORIGIN, path: '/functions/v1/sync', method: 'POST', maxPerLoginStage: 2 },
    ],
    successStorageKey: { origin: ORIGIN, prefix: 'sb-', suffix: '-auth-token' },
  } as const);
  const scriptAuthentication = (setup: AuthSetup = SCRIPT_SETUP, services: readonly string[] = [SERVICE_ORIGIN]) => ({
    ...authenticationOf(setup),
    approvedServiceOrigins: services,
  });

  it('accepts a START with a script login setup and the service origins, and keeps the form navigation digest', () => {
    const message = startWith(scriptAuthentication());
    expect(validateParentToWorkerMessage(message)).toEqual({ ok: true, message });
    // フォームの送信の版 3 は、サービスの Origin なしでも受ける。
    const formSetup = { ...SCRIPT_SETUP, loginPostEndpoints: [{ origin: ORIGIN, path: '/login' }], loginTransport: 'FORM_NAVIGATION',
      scriptLogin: null, loginSideRequests: [], successStorageKey: null } as AuthSetup;
    expect(validateParentToWorkerMessage(startWith(authenticationOf(formSetup))).ok).toBe(true);
    // フォームの送信の設定の SHA-256（LG-3b: 見本を版 2 から版 3 に替えた後の値。前の版 2 の見本の値は `e5ac4b39…` だった）。
    expect(workerAuthenticationDigestOf(SETUP, [ORIGIN], MANUAL_BINDING)).toBe('807fe35d8ebbf8494ab8fc64d1de267a97581fbb74501ddf8796a35f26345678');
    expect(MAX_WORKER_APPROVED_SERVICE_ORIGINS).toBe(MAX_APPROVED_SERVICE_ORIGINS);
  });

  it.each([
    ['no service origins', scriptAuthentication(SCRIPT_SETUP, [])],
    ['a script target outside the service origins', scriptAuthentication({ ...SCRIPT_SETUP,
      scriptLogin: { origin: 'http://127.0.0.1:6173', path: '/auth/v1/token', requiredQuery: [] } } as AuthSetup)],
    ['a script target on a test origin', scriptAuthentication({ ...SCRIPT_SETUP, scriptLogin: { origin: ORIGIN, path: '/auth/v1/token', requiredQuery: [] } } as AuthSetup)],
    ['a side request outside the approved origins', scriptAuthentication({ ...SCRIPT_SETUP,
      loginSideRequests: [{ origin: OTHER_ORIGIN, path: '/rpc', method: 'POST', maxPerLoginStage: 1 }] } as AuthSetup)],
    ['a storage key on a service origin', scriptAuthentication({ ...SCRIPT_SETUP,
      successStorageKey: { origin: SERVICE_ORIGIN, prefix: 'sb-', suffix: '-auth-token' } } as AuthSetup)],
    ['a service origin that is not canonical', scriptAuthentication(SCRIPT_SETUP, [`${SERVICE_ORIGIN}/`])],
    ['a service origin that is also a test origin', scriptAuthentication(SCRIPT_SETUP, [SERVICE_ORIGIN, ORIGIN])],
    ['duplicated service origins', scriptAuthentication(SCRIPT_SETUP, [SERVICE_ORIGIN, SERVICE_ORIGIN])],
    ['too many service origins', scriptAuthentication(SCRIPT_SETUP,
      Array.from({ length: MAX_APPROVED_SERVICE_ORIGINS + 1 }, (_, index) => `http://127.0.0.1:${6000 + index}`))],
    ['a script setup with a value in the storage key', scriptAuthentication({ ...SCRIPT_SETUP,
      successStorageKey: { origin: ORIGIN, prefix: 'sb-', suffix: '-auth-token', value: 'x' } } as unknown as AuthSetup)],
  ] as const)('rejects a version 3 START with %s', (_name, authentication) => {
    expect(validateParentToWorkerMessage(startWith(authentication)).ok).toBe(false);
  });

  // T35a（Task 35 の設計書 3.1、3.2）: 版 3 の任意の項目（`auditReadRequests`・`serviceRequestLimits`）を START で渡す。監査の段の読み取りの手続きの
  // 呼び出しの Origin は、承認したテストの Origin かサービスの Origin。項目のない版 3 の START の SHA-256 は変わらない。
  const READ = { origin: SERVICE_ORIGIN, path: '/rest/v1/rpc/list_members', method: 'POST', maxPerPageLoad: 2 } as const;
  const LIMITS = { perMinute: 60, perRun: 300 } as const;
  it('keeps the digest of a version 3 START without the T35a items, and accepts the items on the approved origins', () => {
    expect(workerAuthenticationDigestOf(SCRIPT_SETUP, [ORIGIN], { ...MANUAL_BINDING, approvedServiceOrigins: [SERVICE_ORIGIN] }))
      .toBe(VERSION_3_START_DIGEST_BEFORE_T35A);
    for (const reads of [[READ], [{ ...READ, origin: ORIGIN, maxPerPageLoad: 10 }]]) {
      const message = startWith(scriptAuthentication({ ...SCRIPT_SETUP, auditReadRequests: reads, serviceRequestLimits: LIMITS } as AuthSetup));
      expect(validateParentToWorkerMessage(message)).toEqual({ ok: true, message });
    }
  });

  it.each([
    ['a read request outside the approved origins', { auditReadRequests: [{ ...READ, origin: OTHER_ORIGIN }] }],
    ['a read request with GET', { auditReadRequests: [{ ...READ, method: 'GET' }] }],
    ['a read request over the limit per page load', { auditReadRequests: [{ ...READ, maxPerPageLoad: 11 }] }],
    // DEF-141: 1 回の Run あたりの上限は 10,000 まで（前は 600 まで）。
    ['a limit per Run over the maximum', { serviceRequestLimits: { ...LIMITS, perRun: 10_001 } }],
  ] as const)('rejects a version 3 START with %s', (_name, change) => {
    expect(validateParentToWorkerMessage(startWith(scriptAuthentication({ ...SCRIPT_SETUP, ...change } as AuthSetup))).ok).toBe(false);
  });
});

/** T35a の項目を足す前の、T34a の版 3 の設定の START の SHA-256（サービスの Origin つき。T35a の前のコードで求めた固定の値）。 */
const VERSION_3_START_DIGEST_BEFORE_T35A = '40e7e0c22977aa1318bde07596e64ad7808b629cbd88bdafd6ce22b802198d92';
