// OP-1（設計書 `doc/design/2026-10-27-beaksight-one-pass-flow-design.md` 4.1.3）: ログインの直後の登録と、値の受け取りの IPC の契約（版 3）。
// - `START` の `authentication.loginRegistration`（ログインの直後に登録を待つ。受け取りを許すときは資格情報の置き場所の根）。手動のログインのまとめて実行だけ。
// - `AUTH_STATE` の `loginEndDetection`（`AWAITING_LOGIN` だけ）と `credentialCapture`（手動のログインの成功だけ。値を持たない）と、観察の `successPathPrefix`。
// - 親 → 子の `CREDENTIAL_SAVE_ALLOWED`・`LOGIN_REGISTERED`・`LOGIN_REGISTRATION_SKIPPED`、子 → 親の `CREDENTIAL_SAVED`。
// 例の値は、匿名の値（`127.0.0.1`、`example`）だけを使う。
import { describe, expect, it } from 'vitest';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import type { AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import { CREDENTIAL_STORE_ERROR_CODES } from '../../src/control/credentials/credential-store.js';
import { CREDENTIAL_PROTECTION_ERROR_CODES } from '../../src/control/credentials/dpapi-protector.js';
import {
  WORKER_CREDENTIAL_SAVE_FAILURE_CODES,
  PARENT_TO_WORKER_MESSAGE_TYPES,
  WORKER_LOGIN_REGISTRATION_TIMEOUT_MS,
  WORKER_PROTOCOL_VERSION,
  WORKER_TO_PARENT_MESSAGE_TYPES,
  targetConfigDigestOf,
  validateParentToWorkerMessage,
  validateWorkerToParentMessage,
  workerAuthenticationDigestOf,
} from '../../src/control/worker-protocol.js';

const ORIGIN = 'http://127.0.0.1:4173';
const SHA256 = targetConfigDigestOf(new TextEncoder().encode('{}'));
const ROOT = process.platform === 'win32' ? 'C:\\example\\root' : '/example/root';
const SETUP: AuthSetup = Object.freeze({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: 'example-chain',
  profileRevision: 1,
  loginStartUrl: `${ORIGIN}/login`,
  loginPostEndpoints: [{ origin: ORIGIN, path: '/login' }],
  successCondition: { pathPrefix: '/admin', selector: null },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: [],
  auditPathPrefixes: ['/admin'],
  maxLoginAttempts: 2,
  allowedIdpOrigins: [],
  automatedLogin: null,
});

const start = (loginRegistration: unknown, chain = true): Record<string, unknown> => ({
  protocol: WORKER_PROTOCOL_VERSION,
  type: 'START',
  jobId: 'job-1',
  jobKind: 'AUDIT',
  targetConfigPath: 'config/targets/example.json',
  startNew: true,
  targetConfigSha256: SHA256,
  authentication: {
    setup: SETUP,
    approvedTestOrigins: [ORIGIN],
    authenticationSha256: workerAuthenticationDigestOf(SETUP, [ORIGIN], { jobKind: 'AUDIT', automatedLogin: null }),
    ...(loginRegistration === undefined ? {} : { loginRegistration }),
  },
  ...(chain ? { chain: { stages: ['AUDIT', 'DISCOVERY', 'READ_CHECK'] } } : {}),
});

const authState = (fields: Record<string, unknown>): Record<string, unknown> => ({
  protocol: WORKER_PROTOCOL_VERSION, type: 'AUTH_STATE', sessionLostUrl: null, ...fields,
});

const parentOk = (value: unknown): boolean => validateParentToWorkerMessage(value).ok;
const workerOk = (value: unknown): boolean => validateWorkerToParentMessage(value).ok;

describe('OP-1: the IPC contract of the registration right after the login (version 3)', () => {
  it('has the version 3, the new message types and the named wait limit', () => {
    expect(WORKER_PROTOCOL_VERSION).toBe('beaksight-worker-message/7'); // OP-2: 書き込みの段で版 4。DEF-180: 前の読み込みの時刻で版 5。OP-H: チェックした画面の数で版 6。OP-L: 保存できなかった理由で版 7
    expect(PARENT_TO_WORKER_MESSAGE_TYPES).toEqual(expect.arrayContaining(['CREDENTIAL_SAVE_ALLOWED', 'LOGIN_REGISTERED', 'LOGIN_REGISTRATION_SKIPPED']));
    expect(WORKER_TO_PARENT_MESSAGE_TYPES).toContain('CREDENTIAL_SAVED');
    expect(WORKER_LOGIN_REGISTRATION_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('accepts the login registration of a manual login chained run, with or without the credential capture', () => {
    expect(parentOk(start({ credentialRoot: null }))).toBe(true);
    expect(parentOk(start({ credentialRoot: ROOT }))).toBe(true);
    // まとめて実行でないジョブ、相対パスの根は拒む。
    expect(parentOk(start({ credentialRoot: null }, false))).toBe(false);
    expect(parentOk(start({ credentialRoot: 'relative/root' }))).toBe(false);
  });

  it('rejects the login registration with an automated login', () => {
    const automatedSetup: AuthSetup = {
      ...SETUP,
      maxLoginAttempts: 1,
      automatedLogin: {
        usernameSelector: '#user', passwordSelector: '#pass', submitSelector: '#go',
        failureConditions: { invalidCredentials: null, accountLocked: null, mfaRequired: null, credentialExpired: null },
      },
    };
    const automatedLogin = { credentialRevision: 1, credentialRoot: ROOT };
    const message = {
      ...start({ credentialRoot: null }),
      authentication: {
        setup: automatedSetup,
        approvedTestOrigins: [ORIGIN],
        authenticationSha256: workerAuthenticationDigestOf(automatedSetup, [ORIGIN], { jobKind: 'AUDIT', automatedLogin }),
        automatedLogin,
        loginRegistration: { credentialRoot: null },
      },
    };
    expect(parentOk(message)).toBe(false);
  });

  it('accepts the login end detection mark only while awaiting the login', () => {
    expect(workerOk(authState({ state: 'AWAITING_LOGIN', loginEndDetection: true }))).toBe(true);
    expect(workerOk(authState({ state: 'AWAITING_LOGIN', loginEndDetection: false }))).toBe(true);
    expect(workerOk(authState({ state: 'AUTHENTICATED', loginEndDetection: true }))).toBe(false);
  });

  it('accepts the capture metadata (no value) only for the success of the manual login', () => {
    const carriedBy = { origin: ORIGIN, path: '/login' };
    expect(workerOk(authState({ state: 'AUTHENTICATED', credentialCapture: { captured: true, carriedBy } }))).toBe(true);
    expect(workerOk(authState({ state: 'AUTHENTICATED', credentialCapture: { captured: false, carriedBy: null } }))).toBe(true);
    expect(workerOk(authState({ state: 'AUTHENTICATED', credentialCapture: { captured: false, carriedBy } }))).toBe(false);
    expect(workerOk(authState({ state: 'AUTHENTICATED', credentialCapture: { captured: true, carriedBy: null } }))).toBe(false);
    expect(workerOk(authState({ state: 'LOGIN_TIMEOUT', credentialCapture: { captured: false, carriedBy: null } }))).toBe(false);
    expect(workerOk(authState({ state: 'AUTHENTICATED', credentialCapture: { captured: true, carriedBy, password: 'x' } }))).toBe(false);
  });

  it('accepts the observed success path prefix (path segments, not value-like) of the manual login', () => {
    expect(workerOk(authState({ state: 'AUTHENTICATED', loginObservation: { successPathPrefix: '/admin' } }))).toBe(true);
    expect(workerOk(authState({ state: 'AUTHENTICATED', loginObservation: { successPathPrefix: 'admin' } }))).toBe(false);
    expect(workerOk(authState({ state: 'AUTHENTICATED', loginObservation: { successPathPrefix: '/admin/dashboard' } }))).toBe(true);
    expect(workerOk(authState({ state: 'AUTHENTICATED', loginObservation: { successPathPrefix: `/admin/${'0123456789abcdef'.repeat(2)}` } }))).toBe(false);
    expect(workerOk(authState({ state: 'AUTHENTICATED', loginObservation: { successPathPrefix: '/admin//x' } }))).toBe(false);
    expect(workerOk(authState({ state: 'AUTHENTICATED', loginObservation: { successPathPrefix: '/' } }))).toBe(false);
  });

  it('accepts CREDENTIAL_SAVED with the revision exactly when saved', () => {
    const saved = (fields: Record<string, unknown>) => ({ protocol: WORKER_PROTOCOL_VERSION, type: 'CREDENTIAL_SAVED', ...fields });
    expect(workerOk(saved({ saved: true, credentialRevision: 1, failureCode: null }))).toBe(true);
    expect(workerOk(saved({ saved: false, credentialRevision: null, failureCode: 'CREDENTIAL_STORAGE_UNSAFE' }))).toBe(true);
    expect(workerOk(saved({ saved: true, credentialRevision: null, failureCode: null }))).toBe(false);
    expect(workerOk(saved({ saved: false, credentialRevision: 1, failureCode: 'CREDENTIAL_STORAGE_UNSAFE' }))).toBe(false);
  });

  it('OP-L L2: CREDENTIAL_SAVED carries a closed failure code exactly when not saved (no value)', () => {
    const saved = (fields: Record<string, unknown>) => ({ protocol: WORKER_PROTOCOL_VERSION, type: 'CREDENTIAL_SAVED', ...fields });
    for (const failureCode of WORKER_CREDENTIAL_SAVE_FAILURE_CODES) {
      expect(workerOk(saved({ saved: false, credentialRevision: null, failureCode }))).toBe(true);
    }
    // 資格情報のファイルの部品と暗号化の部品の誤りのコードを、すべて運べる（書き写しの一覧が owner の一覧からずれない）。
    expect([...WORKER_CREDENTIAL_SAVE_FAILURE_CODES].sort()).toEqual(
      [...CREDENTIAL_STORE_ERROR_CODES, ...CREDENTIAL_PROTECTION_ERROR_CODES, 'CREDENTIAL_SAVE_UNAVAILABLE', 'CREDENTIAL_SAVE_FAILED'].sort(),
    );
    expect(workerOk(saved({ saved: false, credentialRevision: null, failureCode: null }))).toBe(false);
    expect(workerOk(saved({ saved: true, credentialRevision: 1, failureCode: 'CREDENTIAL_STORAGE_UNSAFE' }))).toBe(false);
    expect(workerOk(saved({ saved: false, credentialRevision: null, failureCode: 'secret-value' }))).toBe(false);
    expect(workerOk(saved({ saved: false, credentialRevision: null }))).toBe(false);
  });

  it('accepts the parent messages of the registration', () => {
    expect(parentOk({ protocol: WORKER_PROTOCOL_VERSION, type: 'CREDENTIAL_SAVE_ALLOWED', loginOrigin: ORIGIN })).toBe(true);
    expect(parentOk({ protocol: WORKER_PROTOCOL_VERSION, type: 'CREDENTIAL_SAVE_ALLOWED', loginOrigin: `${ORIGIN}/login` })).toBe(false);
    expect(parentOk({ protocol: WORKER_PROTOCOL_VERSION, type: 'LOGIN_REGISTRATION_SKIPPED' })).toBe(true);
    const registered = {
      protocol: WORKER_PROTOCOL_VERSION,
      type: 'LOGIN_REGISTERED',
      setup: { ...SETUP, profileRevision: 2 },
      approvedServiceOrigins: [],
      authenticationSha256: 'a'.repeat(64),
    };
    expect(parentOk(registered)).toBe(true);
    expect(parentOk({ ...registered, authenticationSha256: 'x' })).toBe(false);
    expect(parentOk({ ...registered, approvedServiceOrigins: [`${ORIGIN}/x`] })).toBe(false);
  });
});
