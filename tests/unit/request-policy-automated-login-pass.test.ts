// DEF-193（設計書 `doc/design/2026-11-04-beaksight-login-session-design.md` 3.2）: 要求の判定（`classifyPassiveRequest`）の、自動ログインの段の通す決まり
// （`authSetup.automatedPassThrough`）。
// - 通す: 登録のない読み取りでない要求（`UNREGISTERED_NON_READ`）と、token の送信先への query の違う送信（`TOKEN_REQUEST_QUERY_MISMATCH`。token の更新）。印
//   `automatedLoginPassThrough` に、通さなければ止めた理由を添える（Guard が回数に数えず、形だけ記録する）。
// - SD-2（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.4）: DELETE、DELETE の上書き、危険な語と読まないパスも通す（前の DEF-194 の決まりで
//   止めた印 `AUTOMATED_LOGIN_RULE_BLOCKED` は作らない）。
// - 止めたまま: ナビゲーション、2 回目のログインの送信（上限）、登録した送信の送り方の違い、必須の query を保って query を足しただけの送信、読み取りの今の決まり。
// - 口がない・手動の段の印・監査の段・書き込みの段・送信の扱いの口と一緒のときは、今の決まりのまま（fail-closed）。
// 例の値は、匿名の値（`example.com`、`example.invalid`）だけを使う。
import { describe, expect, it } from 'vitest';
import {
  classifyPassiveRequest,
  type HttpRequestFacts,
  type LoginStagePolicy,
  type PassiveRequestDecision,
  type PassiveRequestPolicyOptions,
} from '../../src/safety/request-policy.js';

const APP_ORIGIN = 'https://example.com';
const SERVICE_ORIGIN = 'https://service.example.invalid';
const OTHER_ORIGIN = 'https://analytics.example.invalid';
const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([APP_ORIGIN]);
const TOKEN_PATH = '/auth/v1/token';

const automatedStage = (overrides: Partial<LoginStagePolicy> = {}): LoginStagePolicy => ({
  loginPostEndpoints: [],
  remainingPosts: 1,
  scriptRequest: {
    scriptLogin: { origin: SERVICE_ORIGIN, path: TOKEN_PATH, requiredQuery: [{ name: 'grant_type', value: 'password' }] },
    loginSideRequests: [{ origin: SERVICE_ORIGIN, path: '/rest/v1/rpc/log_login', method: 'POST', remainingPosts: 1 }],
    approvedServiceOrigins: [SERVICE_ORIGIN],
  },
  automatedPassThrough: true,
  ...overrides,
});

const fetchOf = (method: string, url: string, headers: Record<string, string> = {}): HttpRequestFacts => ({
  kind: 'HTTP', method, url, isNavigationRequest: false, isMainFrame: false, resourceType: 'fetch',
  sentContent: { headers, formMethodOverrides: () => [] },
});
const navigationOf = (method: string, url: string): HttpRequestFacts =>
  ({ kind: 'HTTP', method, url, isNavigationRequest: true, isMainFrame: true, resourceType: 'document' });

const classify = (facts: HttpRequestFacts, policy: PassiveRequestPolicyOptions): PassiveRequestDecision =>
  classifyPassiveRequest(facts, ALLOWED_ORIGINS, policy);

const passed = (reason: string): PassiveRequestDecision =>
  ({ action: 'ALLOW', delivery: 'DIRECT', automatedLoginPassThrough: { reason } } as PassiveRequestDecision);

describe('DEF-193: the automated login stage passes the site sends except the deletion', () => {
  it.each<[string, HttpRequestFacts, PassiveRequestDecision]>([
    ['the server function call', fetchOf('POST', `${SERVICE_ORIGIN}/functions/v1/sync_access`), passed('UNREGISTERED_NON_READ')],
    ['the data API POST', fetchOf('POST', `${SERVICE_ORIGIN}/rest/v1/login_events`), passed('UNREGISTERED_NON_READ')],
    ['the procedure call', fetchOf('POST', `${SERVICE_ORIGIN}/rest/v1/rpc/current_tenant`), passed('UNREGISTERED_NON_READ')],
    ['a PATCH of the allowed origin', fetchOf('PATCH', `${APP_ORIGIN}/api/session`), passed('UNREGISTERED_NON_READ')],
    ['a POST to another origin (no origin limit, as the audit send policy)', fetchOf('POST', `${OTHER_ORIGIN}/collect`), passed('UNREGISTERED_NON_READ')],
    ['the token refresh of the site script', fetchOf('POST', `${SERVICE_ORIGIN}${TOKEN_PATH}?grant_type=refresh_token`), passed('TOKEN_REQUEST_QUERY_MISMATCH')],
    // SD-2: 削除・削除の上書き・危険な語も通す。
    ['a DELETE', fetchOf('DELETE', `${SERVICE_ORIGIN}/rest/v1/login_events?id=eq.1`), passed('UNREGISTERED_NON_READ')],
    ['a DELETE method override header', fetchOf('POST', `${SERVICE_ORIGIN}/rest/v1/login_events`, { 'X-HTTP-Method-Override': 'DELETE' }), passed('UNREGISTERED_NON_READ')],
    ['a dangerous term in the path and the query', fetchOf('POST', `${SERVICE_ORIGIN}/rest/v1/rpc/delete_member?action=logout`), passed('UNREGISTERED_NON_READ')],
    ['a dangerous token refresh', fetchOf('POST', `${SERVICE_ORIGIN}${TOKEN_PATH}?grant_type=delete_token`), passed('TOKEN_REQUEST_QUERY_MISMATCH')],
  ])('passes %s with the mark', (_label, facts, expected) => {
    expect(classify(facts, { authSetup: automatedStage() })).toEqual(expected);
  });

  // SFIX-1104（SREV-1104 の C-1 の 2）: 必須の query を保って query を足しただけの送信は token の更新として通さない。
  it('keeps a token request with the required query and an added query blocked', () => {
    expect(classify(fetchOf('POST', `${SERVICE_ORIGIN}${TOKEN_PATH}?grant_type=password&x=2`), { authSetup: automatedStage() }))
      .toEqual({ action: 'BLOCK', category: 'REQUEST', reason: 'NON_READ_METHOD', scriptLoginBlock: 'TOKEN_REQUEST_QUERY_MISMATCH' });
    expect(classify(fetchOf('POST', `${SERVICE_ORIGIN}${TOKEN_PATH}?x=2`), { authSetup: automatedStage() }))
      .toEqual({ action: 'BLOCK', category: 'REQUEST', reason: 'NON_READ_METHOD', scriptLoginBlock: 'TOKEN_REQUEST_QUERY_MISMATCH' });
  });

  it('keeps the second login request over the limit, a non-script token request and a navigation POST blocked', () => {
    const tokenUrl = `${SERVICE_ORIGIN}${TOKEN_PATH}?grant_type=password`;
    expect(classify(fetchOf('POST', tokenUrl), { authSetup: automatedStage({ remainingPosts: 0 }) }))
      .toEqual({ action: 'BLOCK', category: 'REQUEST', reason: 'NON_READ_METHOD', scriptLoginBlock: 'TOKEN_REQUEST_OVER_LIMIT' });
    expect(classify({ ...fetchOf('POST', tokenUrl), resourceType: 'ping' }, { authSetup: automatedStage() }))
      .toMatchObject({ action: 'BLOCK', scriptLoginBlock: 'TOKEN_REQUEST_NOT_SCRIPT' });
    expect(classify(navigationOf('POST', `${APP_ORIGIN}/session`), { authSetup: automatedStage() }))
      .toMatchObject({ action: 'BLOCK', reason: 'NON_READ_METHOD', scriptLoginBlock: 'UNREGISTERED_NON_READ' });
    // 登録したログインに伴う送信の上限を超えた送信も、止めたまま。
    expect(classify(fetchOf('POST', `${SERVICE_ORIGIN}/rest/v1/rpc/log_login`), {
      authSetup: automatedStage({
        scriptRequest: { ...automatedStage().scriptRequest!, loginSideRequests: [{ origin: SERVICE_ORIGIN, path: '/rest/v1/rpc/log_login', method: 'POST', remainingPosts: 0 }] },
      }),
    })).toMatchObject({ action: 'BLOCK', scriptLoginBlock: 'SIDE_REQUEST_OVER_LIMIT' });
  });

  it('passes the approved token request as now (counted, no mark)', () => {
    expect(classify(fetchOf('POST', `${SERVICE_ORIGIN}${TOKEN_PATH}?grant_type=password`), { authSetup: automatedStage() }))
      .toEqual({ action: 'ALLOW', delivery: 'DIRECT', loginStageAdmission: { kind: 'SCRIPT_LOGIN_TOKEN' } });
  });

  it('does not work without the mark or with the manual mark (RB-14b: the other stages cannot be given with the login stage)', () => {
    const facts = fetchOf('POST', `${SERVICE_ORIGIN}/functions/v1/sync_access`);
    const blocked = { action: 'BLOCK', category: 'REQUEST', reason: 'NON_READ_METHOD', scriptLoginBlock: 'UNREGISTERED_NON_READ' };
    expect(classify(facts, { authSetup: automatedStage({ automatedPassThrough: undefined }) })).toEqual(blocked);
    // 手動の段の印があれば、手動の段の通し方（印が違う）になる。
    expect(classify(facts, { authSetup: automatedStage({ manualPassThrough: true }) }))
      .toEqual({ action: 'ALLOW', delivery: 'DIRECT', manualLoginPassThrough: { reason: 'UNREGISTERED_NON_READ' } });
    // フォームの送信のログインの段（スクリプトの口がない）では働かない。
    expect(classify(fetchOf('POST', `${APP_ORIGIN}/api/track`), {
      authSetup: { loginPostEndpoints: [{ origin: APP_ORIGIN, path: '/login' }], remainingPosts: 1, automatedPassThrough: true },
    })).toEqual({ action: 'BLOCK', category: 'REQUEST', reason: 'NON_READ_METHOD' });
  });
});
