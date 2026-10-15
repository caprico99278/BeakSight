// CCX-15（共通化の台帳の CC-064）: 認証の設定の送信先への POST かの判定（`isLoginEndpointPost`）の結果を固定する表。
// - 判定は、要求の判定の owner（`classifyPassiveRequest`）に、残りの回数 1 のログインの段の口を渡して ALLOW になるか。置き場所を
//   `src/worker/login-stage-checks.ts` から `src/safety/request-policy.ts` に移しても、結果が変わらないことを確かめる（移す前に PASS させた表）。
// - 回数の上限で止められたかの判定（`loginAttemptsExceeded`。Safety Ledger の `blockedRequests` から、送信先への POST を探す）も固定する。
// 例の値は、匿名の値（`127.0.0.1`、`example.invalid`）だけを使う。
import { describe, expect, it } from 'vitest';
import type { AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import { isLoginEndpointPost, LOGIN_POST_METHOD } from '../../src/safety/request-policy.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { loginAttemptsExceeded } from '../../src/worker/login-stage-checks.js';

const ORIGIN = 'http://127.0.0.1:4173';
const OTHER_PORT_ORIGIN = 'http://127.0.0.1:4174';
const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([ORIGIN]);
const LOGIN_PATH = '/login';
const ENDPOINTS = [{ origin: ORIGIN, path: LOGIN_PATH }] as const;

/** [説明, URL, 許可 Origin, 送信先の一覧, 期待] */
type EndpointRow = readonly [string, string, ReadonlySet<string>, readonly { origin: string; path: string }[], boolean];

const ENDPOINT_TABLE: readonly EndpointRow[] = [
  ['the same URL as the endpoint', `${ORIGIN}${LOGIN_PATH}`, ALLOWED_ORIGINS, ENDPOINTS, true],
  ['a different path', `${ORIGIN}/login2`, ALLOWED_ORIGINS, ENDPOINTS, false],
  ['a path that differs only in case', `${ORIGIN}/Login`, ALLOWED_ORIGINS, ENDPOINTS, false],
  ['a path below the endpoint', `${ORIGIN}${LOGIN_PATH}/next`, ALLOWED_ORIGINS, ENDPOINTS, false],
  ['a dot segment resolved by the URL parser', `${ORIGIN}/a/..${LOGIN_PATH}`, ALLOWED_ORIGINS, ENDPOINTS, true],
  ['with a query', `${ORIGIN}${LOGIN_PATH}?next=%2F`, ALLOWED_ORIGINS, ENDPOINTS, true],
  ['with a fragment', `${ORIGIN}${LOGIN_PATH}#top`, ALLOWED_ORIGINS, ENDPOINTS, true],
  ['a different scheme', `https://127.0.0.1:4173${LOGIN_PATH}`, ALLOWED_ORIGINS, ENDPOINTS, false],
  ['a different port', `${OTHER_PORT_ORIGIN}${LOGIN_PATH}`, ALLOWED_ORIGINS, ENDPOINTS, false],
  ['with userinfo', `http://user@127.0.0.1:4173${LOGIN_PATH}`, ALLOWED_ORIGINS, ENDPOINTS, false],
  ['with userinfo and a password', `http://user:pw@127.0.0.1:4173${LOGIN_PATH}`, ALLOWED_ORIGINS, ENDPOINTS, false],
  ['an upper-case scheme normalized by the URL parser', `HTTP://127.0.0.1:4173${LOGIN_PATH}`, ALLOWED_ORIGINS, ENDPOINTS, true],
  ['a trailing slash on the URL', `${ORIGIN}${LOGIN_PATH}/`, ALLOWED_ORIGINS, ENDPOINTS, false],
  ['a trailing slash on the endpoint', `${ORIGIN}${LOGIN_PATH}`, ALLOWED_ORIGINS, [{ origin: ORIGIN, path: `${LOGIN_PATH}/` }], false],
  ['a trailing slash on the endpoint origin', `${ORIGIN}${LOGIN_PATH}`, ALLOWED_ORIGINS, [{ origin: `${ORIGIN}/`, path: LOGIN_PATH }], true],
  ['a percent-encoded letter in the URL (not decoded)', `${ORIGIN}/%6Cogin`, ALLOWED_ORIGINS, ENDPOINTS, false],
  ['the same percent-encoding in the URL and the endpoint', `${ORIGIN}/l%6Fgin`, ALLOWED_ORIGINS, [{ origin: ORIGIN, path: '/l%6Fgin' }], true],
  ['a lower-case percent-encoding against an upper-case one', `${ORIGIN}/l%6fgin`, ALLOWED_ORIGINS, [{ origin: ORIGIN, path: '/l%6Fgin' }], false],
  ['no endpoints', `${ORIGIN}${LOGIN_PATH}`, ALLOWED_ORIGINS, [], false],
  ['an endpoint path without the leading slash', `${ORIGIN}${LOGIN_PATH}`, ALLOWED_ORIGINS, [{ origin: ORIGIN, path: 'login' }], false],
  ['an endpoint path with a query', `${ORIGIN}${LOGIN_PATH}`, ALLOWED_ORIGINS, [{ origin: ORIGIN, path: `${LOGIN_PATH}?a=1` }], false],
  ['an endpoint path starting with two slashes', `${ORIGIN}//login`, ALLOWED_ORIGINS, [{ origin: ORIGIN, path: '//login' }], false],
  ['an endpoint outside the allowed origins', `${OTHER_PORT_ORIGIN}${LOGIN_PATH}`, ALLOWED_ORIGINS, [{ origin: OTHER_PORT_ORIGIN, path: LOGIN_PATH }], false],
  ['a URL on an allowed origin, but the endpoint on another origin', `${ORIGIN}${LOGIN_PATH}`, ALLOWED_ORIGINS, [{ origin: OTHER_PORT_ORIGIN, path: LOGIN_PATH }], false],
  ['the second of two endpoints', `${ORIGIN}/signin`, ALLOWED_ORIGINS, [...ENDPOINTS, { origin: ORIGIN, path: '/signin' }], true],
  ['an allowed origin set without the URL origin', `${ORIGIN}${LOGIN_PATH}`, new Set(['https://other.example.invalid']), ENDPOINTS, false],
  ['an unparsable URL', 'not a url', ALLOWED_ORIGINS, ENDPOINTS, false],
];

describe('CCX-15: isLoginEndpointPost keeps its results (CC-064)', () => {
  it.each(ENDPOINT_TABLE)('%s', (_label, url, allowedOrigins, endpoints, expected) => {
    expect(isLoginEndpointPost(url, allowedOrigins, endpoints)).toBe(expected);
  });

  it('uses the POST method of the login stage', () => {
    expect(LOGIN_POST_METHOD).toBe('POST');
  });
});

describe('CCX-15: loginAttemptsExceeded keeps its results (CC-064)', () => {
  const setup = { loginPostEndpoints: ENDPOINTS } as unknown as AuthSetup;
  const ledgerWith = (requests: readonly { method: string; url: string }[]): SafetyLedger => {
    const ledger = new SafetyLedger();
    for (const { method, url } of requests) {
      ledger.recordBlockedRequest({ method, url, reason: 'NON_READ_METHOD' });
    }
    return ledger;
  };

  it.each([
    ['no blocked requests', [], false],
    ['a blocked POST to the endpoint', [{ method: 'POST', url: `${ORIGIN}${LOGIN_PATH}` }], true],
    ['a blocked POST to the endpoint with a query', [{ method: 'POST', url: `${ORIGIN}${LOGIN_PATH}?a=1` }], true],
    ['a blocked POST to another path', [{ method: 'POST', url: `${ORIGIN}/other` }], false],
    ['a blocked PUT to the endpoint', [{ method: 'PUT', url: `${ORIGIN}${LOGIN_PATH}` }], false],
    // Safety Ledger は、記録する method を大文字にそろえる（`#boundedMethod`）ので、小文字の `post` も送信先への POST として数える。
    ['a blocked lower-case post to the endpoint (the ledger upper-cases the method)', [{ method: 'post', url: `${ORIGIN}${LOGIN_PATH}` }], true],
    ['a blocked POST to another origin', [{ method: 'POST', url: `${OTHER_PORT_ORIGIN}${LOGIN_PATH}` }], false],
  ] as const)('%s', (_label, requests, expected) => {
    expect(loginAttemptsExceeded(ledgerWith(requests), ALLOWED_ORIGINS, setup)).toBe(expected);
  });
});
