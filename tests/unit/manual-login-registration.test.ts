// ML-a（設計書 `2026-10-19-beaksight-manual-login-pass-through-design.md` 2.3、受け入れ条件 7）と ML-a-fix（6 章の ML-R の行の I-1）: 手動のログインの成功から、
// Guard を通るための認証の設定（版 3。スクリプトで送るログイン）と、プロファイルに足す承認したサービスの Origin を組み立てる部品（`manualLoginRegistrationOf`。純粋）。
// - 組み立ては、今の「登録する」の部品（`loginStageRegistrationOf`・`observedDraftOfObservation`・`approvedServiceOriginsToAdd`）を使う。
// - token の送信先は、`grant_type` を記録した通した送信（最初の行）。
// - ログインに伴う送信として自動で登録するのは、(a) token の送信より前に通した（`beforeToken`）、(b) 種類が fetch・xhr、(c) path が手続きの呼び出し
//   （`hasApiProcedureCallSegment`）、(d) 危険な語・読まないパスでない、をすべて満たすものだけ（回数の上限は見えた回数を 1〜3 に収めたもの）。
// - 承認したサービスの Origin に足すのは、token の送信先と、自動で登録した送信の送り先の Origin だけ。
// - 組み立てられない（token の送信がない、成功の鍵の案がない、足すものがない）ときは、理由だけを返す。値は持たない。
import { describe, expect, it } from 'vitest';
import {
  AUTH_SETUP_SCHEMA_VERSION_3,
  MAX_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE,
  type AuthSetupV3,
} from '../../src/control/auth/auth-setup-contracts.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import { MANUAL_LOGIN_REGISTRATION_SKIP_REASONS, manualLoginRegistrationOf } from '../../src/control/manual-login-registration.js';
import type { WorkerLoginObservation, WorkerLoginStageBlockedRequest, WorkerLoginStageBlockedRequests, WorkerRequestResourceType } from '../../src/control/worker-protocol.js';

const APP = 'https://app.example.com';
const SERVICE = 'https://service.example.invalid';
const ANALYTICS = 'https://collector.analytics.example';
const PROFILE = Object.freeze({ approvedTestOrigins: [APP], approvedServiceOrigins: [] as string[] });

/** フォームの送信のログインの設定（LG-3b: 版 3。前は版 2 の文書だった）。 */
const FORM_SETUP: AuthSetupV3 = Object.freeze({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: 'example-spa',
  profileRevision: 3,
  loginStartUrl: `${APP}/auth`,
  loginPostEndpoints: [{ origin: APP, path: '/login' }],
  successCondition: { pathPrefix: '/admin', selector: null },
  sessionLostCondition: { pathPrefix: '/auth' },
  excludedPaths: ['/rest/v1/rpc/admin_only'],
  auditPathPrefixes: [],
  maxLoginAttempts: 1,
  allowedIdpOrigins: [],
  automatedLogin: null,
});

interface RowOptions {
  readonly count?: number;
  readonly grantType?: string;
  readonly resourceType?: WorkerRequestResourceType;
  readonly beforeToken?: boolean;
}

const row = (origin: string, path: string, options: RowOptions = {}): WorkerLoginStageBlockedRequest => ({
  origin,
  path,
  resourceType: options.resourceType ?? 'fetch',
  reason: 'NON_READ_METHOD',
  count: options.count ?? 1,
  ...(options.grantType === undefined ? {} : { query: { names: ['grant_type'], omitted: 0, values: [{ name: 'grant_type', value: options.grantType }] } }),
  ...(options.beforeToken === true ? { beforeToken: true as const } : {}),
});

const passed = (...requests: WorkerLoginStageBlockedRequest[]): WorkerLoginStageBlockedRequests => ({ requests, unlisted: 0 });
const TOKEN = row(SERVICE, '/auth/v1/token', { grantType: 'password' });
const TENANT_RPC = row(SERVICE, '/rest/v1/rpc/resolve_tenant', { count: 2, beforeToken: true });
const OBSERVATION: WorkerLoginObservation = { storageKeys: { origin: APP, shapes: [{ prefix: '', suffix: '-token' }], omitted: 0 } };

const build = (requests: readonly WorkerLoginStageBlockedRequest[], setup: AuthSetupV3 = FORM_SETUP, profile = PROFILE) =>
  manualLoginRegistrationOf({ setup, profile, passedRequests: passed(...requests), observation: OBSERVATION, nextProfileRevision: 4 });

describe('ML-a: building the auth setup from the manual login', () => {
  it('builds a version 3 script login setup and the service origins to add from the passed requests and the observation', () => {
    const result = build([TENANT_RPC, TOKEN]);
    expect(result).toEqual({
      ok: true,
      addServiceOrigins: [SERVICE],
      setup: {
        ...FORM_SETUP,
        schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
        profileRevision: 4,
        loginTransport: 'SCRIPT_REQUEST',
        scriptLogin: { origin: SERVICE, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },
        // ML-a-fix-2: 回数の上限は、見えた回数でなく、閉じた上限（今の決まりの最大）。
        loginSideRequests: [{ origin: SERVICE, path: '/rest/v1/rpc/resolve_tenant', method: 'POST', maxPerLoginStage: MAX_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE }],
        successStorageKey: { origin: APP, prefix: '', suffix: '-token' },
      },
    });
  });

  // ML-a-fix（ML-R の I-1）: レビューの表。テナントの手続きの呼び出し（token の前）と token の送信先は登録し、第三者の解析・アプリの計測・データを書く送り先・
  // token の後の送信・危険な語の手続きは登録しない。足す Origin は token の送信先だけ（解析の Origin を足さない）。
  it('registers only the procedure calls of fetch or xhr before the token request, and adds only their origins and the token origin (ML-R I-1)', () => {
    const result = build([
      TENANT_RPC,
      row(ANALYTICS, '/v1/collect', { resourceType: 'ping', count: 5, beforeToken: true }),
      row(APP, '/cdn-cgi/rum', { count: 3, beforeToken: true }),
      row(SERVICE, '/rest/v1/rpc/remove_old_sessions', { beforeToken: true }),
      row(SERVICE, '/rest/v1/members', { beforeToken: true }),
      row(ANALYTICS, '/rpc/track', { resourceType: 'ping', beforeToken: true }),
      row(SERVICE, '/rest/v1/rpc/admin_only', { beforeToken: true }),
      TOKEN,
      row(SERVICE, '/rest/v1/rpc/after_login'),
      row(SERVICE, '/auth/v1/token', { grantType: 'refresh_token' }),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.setup.scriptLogin).toEqual({ origin: SERVICE, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] });
    expect(result.setup.loginSideRequests).toEqual([{ origin: SERVICE, path: '/rest/v1/rpc/resolve_tenant', method: 'POST', maxPerLoginStage: MAX_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE }]);
    expect(result.addServiceOrigins).toEqual([SERVICE]);
  });

  // ML-a-fix-2: 手動の段で 1 回しか見えなくても、回数の上限は閉じた上限（ログインの後の呼び出しが、自動ログインの段で上限で止まらない）。
  it('registers an xhr procedure call of the token origin with the closed limit even when it was seen once', () => {
    const result = build([row(SERVICE, '/rpc/resolve', { count: 1, resourceType: 'xhr', beforeToken: true }), TOKEN]);
    expect(result.ok && result.setup.loginSideRequests).toEqual([{ origin: SERVICE, path: '/rpc/resolve', method: 'POST', maxPerLoginStage: MAX_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE }]);
    expect(result.ok && result.addServiceOrigins).toEqual([SERVICE]);
  });

  // ML-a-fix-3（ML-R2 の M-1・M-2。再レビューの表）: ログインに伴う送信は、token の送信先と同じ Origin の、書き込みの語を含まない、符号化していない手続きの呼び出し
  // だけ。足す Origin は token の送信先だけ。token の形の行が違う送信先で 2 つ以上あれば、登録しない。
  it.each<[string, readonly WorkerLoginStageBlockedRequest[]]>([
    ['a procedure call of a third origin before the token request', [row(ANALYTICS, '/rpc/track', { beforeToken: true }), TOKEN]],
    ['a procedure call with a write word (upsert)', [row(SERVICE, '/rest/v1/rpc/upsert_member', { beforeToken: true }), TOKEN]],
    ['a procedure call with a write word (set)', [row(SERVICE, '/rest/v1/rpc/set_tenant', { beforeToken: true }), TOKEN]],
    ['a procedure call with a write word (write)', [row(SERVICE, '/rest/v1/rpc/write_log', { beforeToken: true }), TOKEN]],
    ['a procedure call with a write word (insert)', [row(SERVICE, '/rest/v1/rpc/insertMember', { beforeToken: true }), TOKEN]],
    ['a procedure call with a write word (save)', [row(SERVICE, '/rest/v1/rpc/save-profile', { beforeToken: true }), TOKEN]],
    ['a procedure call with a write word (add)', [row(SERVICE, '/rest/v1/rpc/add_device', { beforeToken: true }), TOKEN]],
    ['an encoded procedure call segment', [row(SERVICE, '/rest/v1/%72pc/resolve_tenant', { beforeToken: true }), TOKEN]],
    ['an upper case procedure call segment', [row(SERVICE, '/rest/v1/RPC/resolve_tenant', { beforeToken: true }), TOKEN]],
    ['a procedure call after the token request', [TOKEN, row(SERVICE, '/rest/v1/rpc/resolve_tenant')]],
    ['a procedure call of a document form post', [row(SERVICE, '/rest/v1/rpc/resolve_tenant', { resourceType: 'document', beforeToken: true }), TOKEN]],
  ])('does not register %s, and adds only the token origin (ML-R2)', (_label, requests) => {
    const result = build(requests);
    expect(result.ok && result.setup.loginSideRequests).toEqual([]);
    expect(result.ok && result.addServiceOrigins).toEqual([SERVICE]);
  });

  it('keeps a procedure call whose name only contains the letters of a write word as a part of another word (word unit)', () => {
    const result = build([row(SERVICE, '/rest/v1/rpc/settings_of_tenant', { beforeToken: true }), row(SERVICE, '/rest/v1/rpc/address_book', { beforeToken: true }), TOKEN]);
    expect(result.ok && result.setup.loginSideRequests.map(({ path }) => path)).toEqual(['/rest/v1/rpc/settings_of_tenant', '/rest/v1/rpc/address_book']);
  });

  it('skips when the token shaped rows have two or more targets of different origins or paths (ML-R2 M-1)', () => {
    expect(build([row(ANALYTICS, '/oauth/token', { grantType: 'password' }), TOKEN])).toEqual({ ok: false, reason: 'MULTIPLE_TOKEN_TARGETS' });
    expect(build([row(SERVICE, '/auth/v2/token', { grantType: 'password' }), TOKEN])).toEqual({ ok: false, reason: 'MULTIPLE_TOKEN_TARGETS' });
    // 同じ送信先の別の grant（token の更新）は 1 つの送信先。
    expect(build([TOKEN, row(SERVICE, '/auth/v1/token', { grantType: 'refresh_token' })]).ok).toBe(true);
    expect(MANUAL_LOGIN_REGISTRATION_SKIP_REASONS).toContain('MULTIPLE_TOKEN_TARGETS');
  });

  it.each<[string, Parameters<typeof manualLoginRegistrationOf>[0], string]>([
    ['no passed request', { setup: FORM_SETUP, profile: PROFILE, passedRequests: undefined, observation: OBSERVATION, nextProfileRevision: 4 }, 'NO_PASSED_REQUESTS'],
    ['no token request', { setup: FORM_SETUP, profile: PROFILE, passedRequests: passed(TENANT_RPC), observation: OBSERVATION, nextProfileRevision: 4 }, 'NO_TOKEN_REQUEST'],
    ['a token request with a dangerous path', {
      setup: FORM_SETUP, profile: PROFILE, passedRequests: passed(row(SERVICE, '/auth/v1/logout', { grantType: 'password' })), observation: OBSERVATION, nextProfileRevision: 4,
    }, 'NO_TOKEN_REQUEST'],
    ['no storage key proposal', { setup: FORM_SETUP, profile: PROFILE, passedRequests: passed(TOKEN), observation: undefined, nextProfileRevision: 4 }, 'NO_STORAGE_KEY'],
    ['a storage key proposal of another origin', {
      setup: FORM_SETUP, profile: PROFILE, passedRequests: passed(TOKEN), observation: { storageKeys: { origin: SERVICE, shapes: [{ prefix: '', suffix: '-token' }], omitted: 0 } }, nextProfileRevision: 4,
    }, 'NO_STORAGE_KEY'],
  ])('skips with %s', (_label, input, reason) => {
    expect(manualLoginRegistrationOf(input)).toEqual({ ok: false, reason });
    expect(MANUAL_LOGIN_REGISTRATION_SKIP_REASONS).toContain(reason);
  });

  it('adds only the new procedure calls before the token request to a script login setup, and skips when nothing is new', () => {
    const v3: AuthSetupV3 = {
      ...FORM_SETUP,
      schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
      loginTransport: 'SCRIPT_REQUEST',
      scriptLogin: { origin: SERVICE, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },
      loginSideRequests: [{ origin: SERVICE, path: '/rest/v1/rpc/resolve_tenant', method: 'POST', maxPerLoginStage: 1 }],
      successStorageKey: { origin: APP, prefix: '', suffix: '-token' },
      serviceRequestLimits: { perMinute: 10, perRun: 100 },
    };
    const profile = { approvedTestOrigins: [APP], approvedServiceOrigins: [SERVICE] };
    expect(build([{ ...TENANT_RPC, reason: 'SIDE_REQUEST_OVER_LIMIT' }, row(SERVICE, '/rest/v1/rpc/after_login')], v3, profile))
      .toEqual({ ok: false, reason: 'NOTHING_NEW' });
    const added = build([{ ...row(SERVICE, '/rest/v1/rpc/sync_tenant', { beforeToken: true }), reason: 'UNREGISTERED_NON_READ' }], v3, profile);
    expect(added).toEqual({
      ok: true,
      addServiceOrigins: [],
      setup: {
        ...v3,
        profileRevision: 4,
        loginSideRequests: [...v3.loginSideRequests, { origin: SERVICE, path: '/rest/v1/rpc/sync_tenant', method: 'POST', maxPerLoginStage: MAX_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE }],
      },
    });
  });
});
