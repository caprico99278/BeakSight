// T34a（Task 34 の設計書 3.2、4 章。T34b の前の安全側の確かめ）: 認証の設定の版 3（スクリプトで送るログイン）を、今の作りのワーカーが受けても、
// スクリプトの送信は通らない（安全側で止まる）。
// - 今のワーカー（`src/worker/authenticated-login.ts` の `runLoginStage`）は、ログインの段の Context に、設定のフォームの送信先（`loginPostEndpoints`。
//   スクリプトで送るログインでは空）と回数の上限（`maxLoginAttempts`）だけを渡す。判定はログインの段の口（`src/safety/request-policy.ts` の
//   `classifyPassiveRequest`）。ここでは、その口に同じ値を渡して、スクリプトの token の送信・ログインに伴う送信・同じ送信先へのページの移動の POST が、
//   どれも止まることを確かめる（止まる所: `classifyPassiveRequest` の `NON_READ_METHOD`。ログインの段で許す POST の判定 `isAllowedLoginPost` に、
//   送信先がない）。
// - スクリプトの送信を通す決まりは T34b（ログインの段の Guard の拡張）が足す。
import { describe, expect, it } from 'vitest';
import { AUTH_SETUP_SCHEMA_VERSION_3, type AuthSetupV3 } from '../../src/control/auth/auth-setup-contracts.js';
import { canonicalPassiveAllowedOrigins, classifyPassiveRequest, type LoginStagePolicy } from '../../src/safety/request-policy.js';

const APP_ORIGIN = 'http://127.0.0.1:4173';
const SERVICE_ORIGIN = 'http://127.0.0.1:5173';

const SCRIPT_SETUP = {
  schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
  profileId: 'example-script',
  profileRevision: 1,
  loginStartUrl: `${APP_ORIGIN}/login`,
  loginPostEndpoints: [],
  successCondition: { pathPrefix: '/dashboard', selector: null },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: [],
  auditPathPrefixes: [],
  maxLoginAttempts: 3,
  allowedIdpOrigins: [],
  automatedLogin: null,
  loginTransport: 'SCRIPT_REQUEST',
  scriptLogin: { origin: SERVICE_ORIGIN, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },
  loginSideRequests: [{ origin: APP_ORIGIN, path: '/functions/v1/sync', method: 'POST', maxPerLoginStage: 1 }],
  successStorageKey: { origin: APP_ORIGIN, prefix: 'sb-', suffix: '-auth-token' },
} as const satisfies AuthSetupV3;

/** 今のワーカーがログインの段の Context に渡す値（`runLoginStage` の `loginPostEndpoints` と `maxLoginAttempts`）。 */
const LOGIN_STAGE: LoginStagePolicy = { loginPostEndpoints: SCRIPT_SETUP.loginPostEndpoints, remainingPosts: SCRIPT_SETUP.maxLoginAttempts };
const ALLOWED = canonicalPassiveAllowedOrigins(new Set([APP_ORIGIN]));

const decide = (url: string, isNavigationRequest: boolean) =>
  classifyPassiveRequest({ kind: 'HTTP', method: 'POST', url, isNavigationRequest, isMainFrame: isNavigationRequest }, ALLOWED, { authSetup: LOGIN_STAGE });

describe('T34a: a version 3 script login setup stops on the safe side in the current login stage', () => {
  const tokenUrl = `${SCRIPT_SETUP.scriptLogin.origin}${SCRIPT_SETUP.scriptLogin.path}?grant_type=password`;
  const sideUrl = `${APP_ORIGIN}${SCRIPT_SETUP.loginSideRequests[0].path}`;

  it.each([
    ['the script token request (fetch)', tokenUrl, false],
    ['a page navigation POST to the token endpoint', tokenUrl, true],
    ['the registered login side request (fetch)', sideUrl, false],
    ['a page navigation POST to the side request path', sideUrl, true],
  ] as const)('blocks %s as a non-read request', (_label, url, navigation) => {
    expect(decide(url, navigation)).toEqual({ action: 'BLOCK', category: 'REQUEST', reason: 'NON_READ_METHOD' });
  });
});
