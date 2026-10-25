// FM-1（設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md` 2.1）: ログインの段の表の 1 行を、利用者の「登録する」で今の認証の設定に足す組み立て
// （`src/control/manual-login-registration.ts` の `loginStageRowRegistrationOf`。自動の登録と同じ部品を使う）。
// - token の送信の行は token の送信先にする（今の送信先と違えば、利用者の選んだ行に替える）。ほかの行は、ログインに伴う送信として足す（回数は閉じた上限）。
// - 成功の鍵は、今の設定の鍵か、ジョブのログインの観察の案（許可 Origin のもの）。フォームの送信の設定からは、スクリプトの送信にする。
// - 危険な語・読まないパス、伏せた path、登録済みの理由の行、すでにある送信、token の送信先がないときのログインに伴う送信は、理由を返す。
import { describe, expect, it } from 'vitest';
import {
  AUTH_SETUP_SCHEMA_VERSION_3,
  MAX_LOGIN_SIDE_REQUESTS,
  MAX_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE,
  type AuthSetupV3,
} from '../../src/control/auth/auth-setup-contracts.js';
import { loginStageRowRegistrationOf } from '../../src/control/manual-login-registration.js';
import type { WorkerLoginObservation, WorkerLoginStageBlockedRequest } from '../../src/control/worker-protocol.js';
import { REDACTED_PATH_SEGMENT } from '../../src/core/url-path-redaction.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';

const TEST_ORIGIN = 'http://127.0.0.1:4173';
const SERVICE_ORIGIN = 'https://service.example.invalid';
const OTHER_ORIGIN = 'https://other.example.invalid';
const NEXT_REVISION = 3;
const PROFILE = Object.freeze({ approvedTestOrigins: [TEST_ORIGIN], approvedServiceOrigins: [] as string[] });
const OBSERVATION: WorkerLoginObservation = { storageKeys: { origin: TEST_ORIGIN, shapes: [{ prefix: '', suffix: '-token' }], omitted: 0 } };

const formSetup: AuthSetupV3 = {
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: 'fm1',
  profileRevision: 2,
  loginStartUrl: `${TEST_ORIGIN}/auth`,
  loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/auth' }],
  successCondition: { pathPrefix: '/admin', selector: null },
  sessionLostCondition: { pathPrefix: '/auth' },
  excludedPaths: ['/auth/logout'],
  auditPathPrefixes: [],
  maxLoginAttempts: 1,
  allowedIdpOrigins: [],
  automatedLogin: null,
};

const scriptSetup: AuthSetupV3 = {
  ...formSetup,
  schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
  loginPostEndpoints: [],
  loginTransport: 'SCRIPT_REQUEST',
  scriptLogin: { origin: SERVICE_ORIGIN, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },
  loginSideRequests: [],
  successStorageKey: { origin: TEST_ORIGIN, prefix: 'sb-', suffix: '-auth-token' },
};

const row = (path: string, extra: Partial<WorkerLoginStageBlockedRequest> = {}): WorkerLoginStageBlockedRequest => ({
  origin: SERVICE_ORIGIN, path, resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 1, ...extra,
});
const tokenRow = (origin = SERVICE_ORIGIN, path = '/auth/v1/token'): WorkerLoginStageBlockedRequest =>
  row(path, { origin, query: { names: ['grant_type'], omitted: 0, values: [{ name: 'grant_type', value: 'password' }] } });

describe('FM-1: registering one row of the login stage table on the spot', () => {
  it('turns the form setup into the script setup with the token target and the observed storage key', () => {
    const result = loginStageRowRegistrationOf({ setup: formSetup, profile: PROFILE, row: tokenRow(), observation: OBSERVATION, nextProfileRevision: NEXT_REVISION });
    expect(result).toEqual({
      ok: true,
      added: { kind: 'TOKEN_TARGET', origin: SERVICE_ORIGIN, path: '/auth/v1/token', queryNames: ['grant_type'] },
      setup: {
        ...formSetup,
        schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
        profileRevision: NEXT_REVISION,
        loginTransport: 'SCRIPT_REQUEST',
        scriptLogin: { origin: SERVICE_ORIGIN, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },
        loginSideRequests: [],
        successStorageKey: { origin: TEST_ORIGIN, prefix: '', suffix: '-token' },
      },
      addServiceOrigins: [SERVICE_ORIGIN],
    });
  });

  it('adds one side request to the script setup with the closed limit, keeping the token target and the storage key', () => {
    // 自動の登録が足さない行（token の後の送信、別の Origin）も、利用者は足せる。
    const result = loginStageRowRegistrationOf({
      setup: scriptSetup, profile: { ...PROFILE, approvedServiceOrigins: [SERVICE_ORIGIN] }, row: row('/v1/after', { origin: OTHER_ORIGIN }),
      observation: undefined, nextProfileRevision: NEXT_REVISION,
    });
    expect(result).toMatchObject({
      ok: true,
      added: { kind: 'SIDE_REQUEST', origin: OTHER_ORIGIN, path: '/v1/after', method: 'POST', maxPerLoginStage: MAX_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE },
      setup: {
        profileRevision: NEXT_REVISION,
        scriptLogin: scriptSetup.scriptLogin,
        successStorageKey: scriptSetup.successStorageKey,
        loginSideRequests: [{ origin: OTHER_ORIGIN, path: '/v1/after', method: 'POST', maxPerLoginStage: MAX_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE }],
      },
      addServiceOrigins: [OTHER_ORIGIN],
    });
  });

  it('replaces the token target with the row the user chose', () => {
    const result = loginStageRowRegistrationOf({
      setup: scriptSetup, profile: PROFILE, row: tokenRow(SERVICE_ORIGIN, '/auth/v2/token'), observation: undefined, nextProfileRevision: NEXT_REVISION,
    });
    expect(result).toMatchObject({ ok: true, setup: { scriptLogin: { path: '/auth/v2/token' }, successStorageKey: scriptSetup.successStorageKey } });
  });

  it('returns the reason for a row it cannot register', () => {
    const of = (setup: AuthSetupV3, target: WorkerLoginStageBlockedRequest, observation: WorkerLoginObservation | undefined = OBSERVATION) =>
      loginStageRowRegistrationOf({ setup, profile: PROFILE, row: target, observation, nextProfileRevision: NEXT_REVISION });
    expect(of(scriptSetup, row('/auth/logout'))).toEqual({ ok: false, reason: 'EXCLUDED_PATH' });
    expect(of(scriptSetup, row('/rest/v1/rpc/delete_all'))).toEqual({ ok: false, reason: 'EXCLUDED_PATH' });
    expect(of(scriptSetup, row(`/v1/users/${REDACTED_PATH_SEGMENT}`))).toEqual({ ok: false, reason: 'REDACTED_PATH' });
    expect(of(scriptSetup, row('/v1/after', { reason: 'SIDE_REQUEST_OVER_LIMIT' }))).toEqual({ ok: false, reason: 'ALREADY_REGISTERED' });
    expect(of(scriptSetup, tokenRow())).toEqual({ ok: false, reason: 'ALREADY_REGISTERED' });
    expect(of(formSetup, row('/v1/after'))).toEqual({ ok: false, reason: 'NO_TOKEN_TARGET' });
    expect(loginStageRowRegistrationOf({ setup: formSetup, profile: PROFILE, row: tokenRow(), observation: undefined, nextProfileRevision: NEXT_REVISION }))
      .toEqual({ ok: false, reason: 'NO_STORAGE_KEY' });
    // 許可 Origin の外の鍵の案は使わない。
    const outside: WorkerLoginObservation = { storageKeys: { origin: OTHER_ORIGIN, shapes: [{ prefix: '', suffix: '-token' }], omitted: 0 } };
    expect(of(formSetup, tokenRow(), outside)).toEqual({ ok: false, reason: 'NO_STORAGE_KEY' });
    const full: AuthSetupV3 = {
      ...scriptSetup,
      loginSideRequests: Array.from({ length: MAX_LOGIN_SIDE_REQUESTS }, (_, index) => ({ origin: SERVICE_ORIGIN, path: `/v1/side${String(index)}`, method: 'POST' as const, maxPerLoginStage: 1 })),
    };
    expect(of(full, row('/v1/after'))).toEqual({ ok: false, reason: 'SIDE_REQUEST_LIMIT' });
    expect(of(full, row('/v1/side0'))).toEqual({ ok: false, reason: 'ALREADY_REGISTERED' });
  });
});
