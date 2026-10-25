// ML-a（設計書 `2026-10-19-beaksight-manual-login-pass-through-design.md` 2.1）: 要求の判定（`classifyPassiveRequest`）の、手動のログインの段の
// 通す決まり（`authSetup.manualPassThrough`）。
// - 手動のログインの段では、今の決まりで止める読み取りでない要求（ログインの送信、手続きの呼び出し）を、止めずに通す（`manualLoginPassThrough`。通さなければ
//   止めた理由を添える。Guard が形だけ記録する）。
// - 今のまま止める: 読み取り（許可 Origin の外への読み取り。T26g-1）、WebSocket、許可 Origin の外への main frame の移動（読み取りでも、読み取りでなくても）。
// - 口がない（自動ログイン）ときと、監査の段・書き込みの段の口と一緒のときは、今の決まりのまま（回帰）。
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
const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([APP_ORIGIN]);
const TOKEN_URL = `${SERVICE_ORIGIN}/auth/v1/token?grant_type=password`;
const RPC_URL = `${SERVICE_ORIGIN}/rest/v1/rpc/current_tenant`;
const FORM_URL = `${APP_ORIGIN}/login`;

const formStage = (manual: boolean): LoginStagePolicy => ({
  loginPostEndpoints: [{ origin: APP_ORIGIN, path: '/login' }],
  remainingPosts: 1,
  ...(manual ? { manualPassThrough: true as const } : {}),
});

const scriptStage = (manual: boolean, submissionWindowOpen = false): LoginStagePolicy => ({
  loginPostEndpoints: [],
  remainingPosts: 1,
  submissionWindowOpen,
  scriptRequest: {
    scriptLogin: { origin: SERVICE_ORIGIN, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },
    loginSideRequests: [],
    approvedServiceOrigins: [SERVICE_ORIGIN],
  },
  ...(manual ? { manualPassThrough: true as const } : {}),
});

const fetchOf = (method: string, url: string): HttpRequestFacts => ({ kind: 'HTTP', method, url, isNavigationRequest: false, isMainFrame: false, resourceType: 'fetch' });
const navigationOf = (method: string, url: string): HttpRequestFacts => ({ kind: 'HTTP', method, url, isNavigationRequest: true, isMainFrame: true, resourceType: 'document' });
const subresourceOf = (url: string): HttpRequestFacts => ({ kind: 'HTTP', method: 'GET', url, isNavigationRequest: false, isMainFrame: false, resourceType: 'script' });

const classify = (facts: HttpRequestFacts | { readonly kind: 'WEBSOCKET'; readonly url: string }, policy: PassiveRequestPolicyOptions): PassiveRequestDecision =>
  classifyPassiveRequest(facts, ALLOWED_ORIGINS, policy);

const PASSED_NON_READ = (reason: string): PassiveRequestDecision =>
  ({ action: 'ALLOW', delivery: 'DIRECT', manualLoginPassThrough: { reason } } as PassiveRequestDecision);

describe('ML-a: the manual login stage passes the requests the page sends', () => {
  it.each<[string, HttpRequestFacts, PassiveRequestDecision]>([
    ['the token request to another origin (the form login setup)', fetchOf('POST', TOKEN_URL), PASSED_NON_READ('NON_READ_METHOD')],
    ['the procedure call to another origin', fetchOf('POST', RPC_URL), PASSED_NON_READ('NON_READ_METHOD')],
    ['a PATCH to the allowed origin', fetchOf('PATCH', `${APP_ORIGIN}/api/session`), PASSED_NON_READ('NON_READ_METHOD')],
  ])('passes %s and marks it (form login setup)', (_label, facts, expected) => {
    expect(classify(facts, { authSetup: formStage(true) })).toEqual(expected);
  });

  it('keeps blocking the reads of another origin (T26g-1: the typed values are not carried by a load of another origin)', () => {
    expect(classify(subresourceOf(`${SERVICE_ORIGIN}/sdk.js`), { authSetup: formStage(true) })).toMatchObject({ action: 'BLOCK', category: 'LOGIN_STAGE' });
    expect(classify(fetchOf('GET', `${SERVICE_ORIGIN}/rest/v1/members`), { authSetup: formStage(true) })).toMatchObject({ action: 'BLOCK', category: 'LOGIN_STAGE' });
  });

  it('passes the form POST to the endpoint as now (no mark), and a second form POST over the limit with the mark', () => {
    expect(classify(navigationOf('POST', FORM_URL), { authSetup: formStage(true) })).toEqual({ action: 'ALLOW', delivery: 'INSPECT_REDIRECTS' });
    expect(classify(navigationOf('POST', FORM_URL), { authSetup: { ...formStage(true), remainingPosts: 0 } }))
      .toEqual({ action: 'ALLOW', delivery: 'INSPECT_REDIRECTS', manualLoginPassThrough: { reason: 'NON_READ_METHOD' } });
  });

  it('keeps blocking a main frame navigation outside the allowed origins and a WebSocket', () => {
    expect(classify(navigationOf('GET', `${SERVICE_ORIGIN}/login`), { authSetup: formStage(true) }))
      .toEqual({ action: 'BLOCK', category: 'NAVIGATION', reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION' });
    expect(classify(navigationOf('POST', `${SERVICE_ORIGIN}/login`), { authSetup: formStage(true) }))
      .toEqual({ action: 'BLOCK', category: 'REQUEST', reason: 'NON_READ_METHOD' });
    expect(classify({ kind: 'WEBSOCKET', url: 'wss://example.com/socket' }, { authSetup: formStage(true) }))
      .toEqual({ action: 'BLOCK', category: 'WEBSOCKET', reason: 'PASSIVE_WEBSOCKET' });
  });

  it('keeps the admitted token request of the script login as now, passes the unregistered requests with the mark, and keeps the reads in the window as now', () => {
    expect(classify(fetchOf('POST', TOKEN_URL), { authSetup: scriptStage(true) }))
      .toEqual({ action: 'ALLOW', delivery: 'DIRECT', loginStageAdmission: { kind: 'SCRIPT_LOGIN_TOKEN' } });
    expect(classify(fetchOf('POST', RPC_URL), { authSetup: scriptStage(true) })).toEqual(PASSED_NON_READ('UNREGISTERED_NON_READ'));
    expect(classify(fetchOf('POST', TOKEN_URL), { authSetup: { ...scriptStage(true), remainingPosts: 0 } })).toEqual(PASSED_NON_READ('TOKEN_REQUEST_OVER_LIMIT'));
    expect(classify(subresourceOf('https://cdn.example.invalid/chunk.js'), { authSetup: scriptStage(true, true) })).toMatchObject({ action: 'BLOCK', category: 'LOGIN_STAGE' });
    expect(classify(fetchOf('GET', `${SERVICE_ORIGIN}/rest/v1/members`), { authSetup: scriptStage(true, true) }))
      .toEqual({ action: 'ALLOW', delivery: 'DIRECT', loginStageAdmission: { kind: 'SERVICE_ORIGIN_READ' } });
  });
});

describe('T44R M-1: the manual stage reads of the approved service origins without the script target', () => {
  const emptyStage = (manual: boolean, serviceOrigins: readonly string[] | null = [SERVICE_ORIGIN]): LoginStagePolicy => ({
    loginPostEndpoints: [],
    remainingPosts: 1,
    ...(manual ? { manualPassThrough: true as const } : {}),
    ...(serviceOrigins === null ? {} : { manualServiceReadOrigins: serviceOrigins }),
  });
  const SERVICE_READ: PassiveRequestDecision = { action: 'ALLOW', delivery: 'DIRECT', loginStageAdmission: { kind: 'SERVICE_ORIGIN_READ' } };

  it('passes the GET and HEAD to the approved service origin that are not navigations', () => {
    expect(classify(fetchOf('GET', `${SERVICE_ORIGIN}/rest/v1/members`), { authSetup: emptyStage(true) })).toEqual(SERVICE_READ);
    expect(classify(fetchOf('HEAD', `${SERVICE_ORIGIN}/rest/v1/members`), { authSetup: emptyStage(true) })).toEqual(SERVICE_READ);
    expect(classify(subresourceOf(`${SERVICE_ORIGIN}/sdk.js`), { authSetup: emptyStage(true) })).toEqual(SERVICE_READ);
  });

  it('keeps the reads of the other origins and the main frame navigation to the service origin blocked', () => {
    expect(classify(fetchOf('GET', 'https://other.example.invalid/x'), { authSetup: emptyStage(true) })).toMatchObject({ action: 'BLOCK', category: 'LOGIN_STAGE' });
    expect(classify(navigationOf('GET', `${SERVICE_ORIGIN}/login`), { authSetup: emptyStage(true) }))
      .toEqual({ action: 'BLOCK', category: 'NAVIGATION', reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION' });
  });

  it('keeps the non read requests as the manual stage passes them (passed and marked, not counted as a service read)', () => {
    expect(classify(fetchOf('POST', TOKEN_URL), { authSetup: emptyStage(true) })).toEqual(PASSED_NON_READ('NON_READ_METHOD'));
    expect(classify(fetchOf('POST', RPC_URL), { authSetup: emptyStage(true) })).toEqual(PASSED_NON_READ('NON_READ_METHOD'));
  });

  it('does not pass the service origin reads without the manual entry, or with the write stage or the audit stage entry (fail-closed)', () => {
    const read = fetchOf('GET', `${SERVICE_ORIGIN}/rest/v1/members`);
    expect(classify(read, { authSetup: emptyStage(false) })).toMatchObject({ action: 'BLOCK', category: 'LOGIN_STAGE' });
    expect(classify(read, { authSetup: emptyStage(true, null) })).toMatchObject({ action: 'BLOCK', category: 'LOGIN_STAGE' });
    const writeStage = { writeEndpoint: { origin: APP_ORIGIN, path: '/members' }, remainingPosts: 1 };
    expect(classify(read, { authSetup: emptyStage(true), writeStage }).action).toBe('BLOCK');
    const auditStage = {
      approvedServiceOrigins: [],
      auditReadRequests: [],
      scriptLogin: { origin: SERVICE_ORIGIN, path: '/auth/v1/token', requiredQuery: [] },
    };
    expect(classify(read, { authSetup: emptyStage(true), auditStage }).action).toBe('BLOCK');
  });
});

describe('ML-a: the other stages keep the current rules (regression)', () => {
  it('blocks the same requests without the manual entry (the automated login)', () => {
    expect(classify(fetchOf('POST', TOKEN_URL), { authSetup: formStage(false) })).toEqual({ action: 'BLOCK', category: 'REQUEST', reason: 'NON_READ_METHOD' });
    expect(classify(subresourceOf(`${SERVICE_ORIGIN}/sdk.js`), { authSetup: formStage(false) }))
      .toMatchObject({ action: 'BLOCK', category: 'LOGIN_STAGE' });
    expect(classify(fetchOf('POST', RPC_URL), { authSetup: scriptStage(false) }))
      .toEqual({ action: 'BLOCK', category: 'REQUEST', reason: 'NON_READ_METHOD', scriptLoginBlock: 'UNREGISTERED_NON_READ' });
  });

  it('does not pass anything with the write stage entry or the audit stage entry given together (fail-closed)', () => {
    const writeStage = { writeEndpoint: { origin: APP_ORIGIN, path: '/members' }, remainingPosts: 1 };
    expect(classify(fetchOf('POST', TOKEN_URL), { authSetup: formStage(true), writeStage }).action).toBe('BLOCK');
    const auditStage = {
      approvedServiceOrigins: [SERVICE_ORIGIN],
      auditReadRequests: [],
      scriptLogin: { origin: SERVICE_ORIGIN, path: '/auth/v1/token', requiredQuery: [] },
    };
    expect(classify(fetchOf('POST', RPC_URL), { authSetup: formStage(true), auditStage }).action).toBe('BLOCK');
  });

  it('keeps the public audit and the audit stage as read only', () => {
    expect(classify(fetchOf('POST', `${APP_ORIGIN}/api`), {})).toEqual({ action: 'BLOCK', category: 'REQUEST', reason: 'NON_READ_METHOD' });
  });
});
