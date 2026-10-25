// T39b（Task 39 の設計書 3.1、3.3）: 要求の判定（`classifyPassiveRequest`。Guard の `decideGuardRequest` が CDP の要求の層の判定に使う唯一の判定）の、
// API のシナリオの書き込みの段の分岐を表で確かめる。
// - 送信の窓の中で、残りの回数が 1 のとき、承認した API の Origin への `POST`・`PATCH` のうち、main frame のページのスクリプトが送った（`mainFrameScript`）
//   ナビゲーションでない fetch・xhr だけを、照合にかける印（`writeStageApiWrite`）つきで ALLOW する（照合は Guard が続けて行う）。
// - ほか（窓の外、2 回目、Worker・iframe、beacon、ナビゲーション、ほかの method・Origin）は止める。監査の段の口があれば、その判定で止まる。
// - API の書き込みの段では、監査の段の口（承認したサービスの Origin の読み取りと、登録した読み取りの手続きの呼び出し）が働く。登録した呼び出しは、
//   窓の外だけ通す。サービスの Origin の読み取りは、窓の中でも通す（ユーザーの判断）。
// - form の書き込みの段（`apiOrigin` なし）は今のまま。API の書き込みの段では、form の送信（main frame のナビゲーションの POST）を通さない。
import { describe, expect, it } from 'vitest';
import {
  classifyPassiveRequest,
  type AuditStagePolicy,
  type HttpRequestFacts,
  type PassiveRequestDecision,
  type PassiveRequestPolicyOptions,
  type RequestResourceType,
  type WriteStagePolicy,
} from '../../src/safety/request-policy.js';

const APP_ORIGIN = 'https://app.example.com';
const API_ORIGIN = 'https://api.example.com';
const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([APP_ORIGIN]);
const API_URL = `${API_ORIGIN}/rest/v1/members`;
const RPC_READ_URL = `${API_ORIGIN}/rest/v1/rpc/list_members`;

const API_CLOSED: WriteStagePolicy = Object.freeze({
  writeEndpoint: Object.freeze({ origin: API_ORIGIN, path: '/rest/v1/members' }),
  remainingPosts: 1,
  apiOrigin: API_ORIGIN,
});
const API_OPEN: WriteStagePolicy = Object.freeze({ ...API_CLOSED, submissionWindowOpen: true });
const API_SPENT: WriteStagePolicy = Object.freeze({ ...API_OPEN, remainingPosts: 0 });
const AUDIT_STAGE: AuditStagePolicy = Object.freeze({
  approvedServiceOrigins: Object.freeze([API_ORIGIN]),
  auditReadRequests: Object.freeze([Object.freeze({ origin: API_ORIGIN, path: '/rest/v1/rpc/list_members', method: 'POST', remainingPosts: 1 })]),
  scriptLogin: Object.freeze({ origin: API_ORIGIN, path: '/auth/v1/token', requiredQuery: Object.freeze([]) }),
});

const API_WRITE: PassiveRequestDecision = { action: 'ALLOW', delivery: 'DIRECT', writeStageApiWrite: true };
const NON_READ: PassiveRequestDecision = { action: 'BLOCK', category: 'REQUEST', reason: 'NON_READ_METHOD' };
const UNREGISTERED: PassiveRequestDecision = { action: 'BLOCK', category: 'REQUEST', reason: 'NON_READ_METHOD', auditStageBlock: 'UNREGISTERED_NON_READ' };
const SERVICE_READ: PassiveRequestDecision = { action: 'ALLOW', delivery: 'DIRECT', auditStageAdmission: { kind: 'SERVICE_ORIGIN_READ' } };
const RPC_READ: PassiveRequestDecision = {
  action: 'ALLOW',
  delivery: 'DIRECT',
  auditStageAdmission: { kind: 'AUDIT_READ_REQUEST', index: 0, serviceOrigin: true },
};
/** 登録した読み取りの手続きの呼び出しを、通さない段（窓の中、form の書き込みの段）で止めた判定（共通の理由 `OVER_LIMIT` の写し）。 */
const RPC_HELD: PassiveRequestDecision = { action: 'BLOCK', category: 'REQUEST', reason: 'NON_READ_METHOD', auditStageBlock: 'READ_REQUEST_OVER_LIMIT' };
const IN_WINDOW: PassiveRequestDecision = { action: 'BLOCK', category: 'WRITE_STAGE', reason: 'SUBMISSION_WINDOW' };

const script = (
  method: string,
  url: string,
  options: { readonly mainFrameScript?: boolean; readonly resourceType?: RequestResourceType; readonly navigation?: boolean } = {},
): HttpRequestFacts => ({
  kind: 'HTTP',
  method,
  url,
  isNavigationRequest: options.navigation ?? false,
  isMainFrame: options.navigation ?? false,
  resourceType: options.resourceType ?? 'fetch',
  mainFrameScript: options.mainFrameScript ?? true,
});

/** `auditStage` が null なら、監査の段の口を渡さない。 */
const classify = (facts: HttpRequestFacts, writeStage: WriteStagePolicy, auditStage: AuditStagePolicy | null = AUDIT_STAGE): PassiveRequestDecision => {
  const policy: PassiveRequestPolicyOptions = { writeStage, ...(auditStage === null ? {} : { auditStage }) };
  return classifyPassiveRequest(facts, ALLOWED_ORIGINS, policy);
};

describe('T39b: the API write branch of the request decision', () => {
  it.each<[string, HttpRequestFacts, WriteStagePolicy, PassiveRequestDecision]>([
    ['the first POST in the window from the main frame script', script('POST', API_URL), API_OPEN, API_WRITE],
    ['the first PATCH in the window (with a filter)', script('PATCH', `${API_URL}?id=eq.1`), API_OPEN, API_WRITE],
    ['an xhr POST in the window', script('POST', API_URL, { resourceType: 'xhr' }), API_OPEN, API_WRITE],
    // T39R-fix（M-2）: 照合にかけるのは承認の endpoint の path に当たる要求だけ。ほかの path は、今の決まりで止める（書き込みの機会を使わない）。
    ['the POST to another path of the API origin (not the check target)', script('POST', `${API_ORIGIN}/rest/v1/admins`), API_OPEN, UNREGISTERED],
    ['the PATCH to a longer path of the API origin', script('PATCH', `${API_URL}/1?id=eq.1`), API_OPEN, UNREGISTERED],
    ['the POST to the approved path with a trailing slash', script('POST', `${API_URL}/`), API_OPEN, UNREGISTERED],
    ['the POST to the approved path with a query (the check sees the query)', script('POST', `${API_URL}?select=*`), API_OPEN, API_WRITE],
    ['the POST before the window', script('POST', API_URL), API_CLOSED, UNREGISTERED],
    ['the second POST (no remaining)', script('POST', API_URL), API_SPENT, UNREGISTERED],
    ['a POST from a Worker or an iframe (not the main frame script)', script('POST', API_URL, { mainFrameScript: false }), API_OPEN, UNREGISTERED],
    ['a beacon', script('POST', API_URL, { resourceType: 'ping' }), API_OPEN, UNREGISTERED],
    ['a POST without the resource type', { kind: 'HTTP', method: 'POST', url: API_URL, isNavigationRequest: false, isMainFrame: false, mainFrameScript: true }, API_OPEN, UNREGISTERED],
    ['a main frame navigation POST (a form) to the API', script('POST', API_URL, { navigation: true, resourceType: 'document' }), API_OPEN, UNREGISTERED],
    ['PUT', script('PUT', API_URL), API_OPEN, UNREGISTERED],
    ['DELETE', script('DELETE', API_URL), API_OPEN, UNREGISTERED],
    ['a POST to an unapproved origin', script('POST', 'https://other.example.com/rest/v1/members'), API_OPEN, UNREGISTERED],
    ['a POST to the app origin', script('POST', `${APP_ORIGIN}/rest/v1/members`), API_OPEN, UNREGISTERED],
  ])('%s', (_label, facts, writeStage, expected) => {
    expect(classify(facts, writeStage)).toEqual(expected);
  });

  it('blocks a non-read request with the plain reason when the audit stage entry is not given', () => {
    expect(classify(script('POST', API_URL), API_CLOSED, null)).toEqual(NON_READ);
    expect(classify(script('POST', API_URL), API_OPEN, null)).toEqual(API_WRITE);
    // T39R-fix（M-2）: 監査の段の口がなくても、承認の endpoint の path でない要求は照合にかけずに止める。
    expect(classify(script('POST', `${API_ORIGIN}/rest/v1/admins`), API_OPEN, null)).toEqual(NON_READ);
  });

  it('holds the registered read procedure call in the window without taking it as the check target (T39R-fix M-2)', () => {
    expect(classify(script('POST', RPC_READ_URL), API_OPEN)).toEqual(RPC_HELD);
    expect(classify(script('POST', RPC_READ_URL), API_OPEN, null)).toEqual(NON_READ);
  });

  it('lets the registered read procedure call through only outside the window, and the service origin reads in and outside the window', () => {
    expect(classify(script('POST', RPC_READ_URL), API_CLOSED)).toEqual(RPC_READ);
    expect(classify(script('POST', RPC_READ_URL), API_SPENT)).toEqual(RPC_HELD);
    expect(classify(script('GET', `${API_URL}?select=*`), API_CLOSED)).toEqual(SERVICE_READ);
    expect(classify(script('GET', `${API_URL}?select=*`), API_OPEN)).toEqual(SERVICE_READ);
    expect(classify(script('GET', `${APP_ORIGIN}/chunk.js`, { resourceType: 'script' }), API_OPEN)).toEqual(IN_WINDOW);
  });

  it('keeps the form write stage (no API origin) as it was: no API write, the registered call blocked', () => {
    const form: WriteStagePolicy = Object.freeze({
      writeEndpoint: Object.freeze({ origin: APP_ORIGIN, path: '/members' }),
      remainingPosts: 1,
      submissionWindowOpen: true,
    });
    expect(classify(script('POST', API_URL), form)).toEqual(UNREGISTERED);
    expect(classify(script('POST', `${APP_ORIGIN}/members`, { navigation: true, resourceType: 'document' }), form))
      .toEqual({ action: 'ALLOW', delivery: 'INSPECT_REDIRECTS' });
    expect(classify(script('POST', RPC_READ_URL), { ...form, submissionWindowOpen: false })).toEqual(RPC_HELD);
  });
});
