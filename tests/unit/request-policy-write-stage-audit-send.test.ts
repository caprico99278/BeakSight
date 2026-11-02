// OP-N（設計書 `doc/design/2026-10-27-beaksight-one-pass-flow-design.md` 4.1.7 の N2）: 書き込みの段の口（`writeStage`）と、監査の段の送信の扱い
// `PASS_EXCEPT_DELETE` の口（`auditSend`）を一緒に渡したときの、要求の判定（`classifyPassiveRequest`）を表で確かめる。
// - 値を入れる前（送信の窓を開く前）: 監査の段と同じ判定（`auditSendDecisionOf`）で、サイトが自動で送る読み取りでない要求を通す。加えて書き込みの段では、
//   送り先を許可 Origin と承認したサービスの Origin に限り、承認した送信の送信先（Origin と path）への要求は通さない（数える書き込みは承認した 1 件だけ）。
// - 値を入れた後（窓の中）: 通さない（N1 を優先。今どおり止める）。
// - 押した後（窓を閉じた後。`valuesEntered`）: 通さない（OP-REV3 の C-2。値はヘッダや Cookie でも運べ、照らしきれないため。N2 で通すのは値を入れる前だけ）。
// - OP-REV3（I-1）: 承認した送信の送信先とその下の path は、正規化した形（末尾の `/`、`//`、大文字と小文字、`%XX`）でも除く。
// - WebSocket は、書き込みの段では通さない（値を入れる前に開いた接続は、値を入れた後も開いたままになるため）。
// - ログインの段の口と一緒なら、今どおり使わない。
// 例の値は、匿名の値（`example.com`、`example.invalid`）だけを使う。
import { describe, expect, it } from 'vitest';
import {
  classifyPassiveRequest,
  type AuditSendPolicy,
  type AuditStagePolicy,
  type HttpRequestFacts,
  type PassiveRequestDecision,
  type PassiveRequestPolicyOptions,
  type RequestSentContent,
  type WriteStagePolicy,
} from '../../src/safety/request-policy.js';

const APP_ORIGIN = 'https://app.example.com';
const SERVICE_ORIGIN = 'https://service.example.invalid';
const OTHER_ORIGIN = 'https://other.example.invalid';
const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([APP_ORIGIN]);
const DANGEROUS_TERMS = Object.freeze(['logout', 'delete']);

const auditSend = (remainingPasses = 1): AuditSendPolicy => ({
  approvedServiceOrigins: [SERVICE_ORIGIN],
  dangerousTerms: DANGEROUS_TERMS,
  remainingPasses,
  remainingWebSockets: 1,
});

const FORM_BEFORE_FILL: WriteStagePolicy = Object.freeze({
  writeEndpoint: Object.freeze({ origin: APP_ORIGIN, path: '/members' }),
  remainingPosts: 0,
  submissionWindowOpen: false,
});
const FORM_AFTER_FILL: WriteStagePolicy = Object.freeze({ ...FORM_BEFORE_FILL, submissionWindowOpen: true, valuesEntered: true });
const FORM_AFTER_PRESS: WriteStagePolicy = Object.freeze({ ...FORM_BEFORE_FILL, submissionWindowOpen: false, valuesEntered: true });

const NO_OVERRIDES = (): readonly string[] => [];
const sent = (): RequestSentContent => ({ headers: { 'content-type': 'application/json' }, formMethodOverrides: NO_OVERRIDES });

const facts = (method: string, url: string, sentContent?: RequestSentContent, isNavigationRequest = false): HttpRequestFacts => ({
  kind: 'HTTP', method, url, isNavigationRequest, isMainFrame: isNavigationRequest, resourceType: isNavigationRequest ? 'document' : 'fetch',
  ...(sentContent === undefined ? {} : { sentContent }),
});

const decide = (request: HttpRequestFacts, policy: PassiveRequestPolicyOptions): PassiveRequestDecision =>
  classifyPassiveRequest(request, ALLOWED_ORIGINS, policy);

const PASSED = { action: 'ALLOW', delivery: 'DIRECT', auditSendAdmission: true };
const NON_READ = { action: 'BLOCK', category: 'REQUEST', reason: 'NON_READ_METHOD' };

describe('OP-N (N2): the audit send policy in the write stage', () => {
  const before: PassiveRequestPolicyOptions = { writeStage: FORM_BEFORE_FILL, auditSend: auditSend() };

  it('passes the requests that the site sends by itself before the values are typed, to the test Origin and the approved service Origin', () => {
    expect(decide(facts('POST', `${APP_ORIGIN}/rpc/status`), before)).toEqual(PASSED);
    expect(decide(facts('PUT', `${SERVICE_ORIGIN}/rest/v1/rpc/usage`), before)).toEqual(PASSED);
    expect(decide(facts('PATCH', `${SERVICE_ORIGIN}/rest/v1/media?id=eq.1`), before)).toEqual(PASSED);
  });

  it('does not pass a DELETE, a dangerous word, a navigation, or a request outside the test and the approved service Origins before the values are typed', () => {
    expect(decide(facts('DELETE', `${SERVICE_ORIGIN}/rest/v1/previews?id=eq.1`), before)).toEqual(NON_READ);
    expect(decide(facts('POST', `${APP_ORIGIN}/logout`), before)).toEqual(NON_READ);
    expect(decide(facts('POST', `${APP_ORIGIN}/rpc/status`, undefined, true), before)).toMatchObject({ action: 'BLOCK' });
    expect(decide(facts('POST', `${OTHER_ORIGIN}/collect`), before)).toEqual(NON_READ);
    expect(decide(facts('POST', 'not a url'), before)).toMatchObject({ action: 'BLOCK' });
  });

  it('does not pass a request to the endpoint of the approved send (only the approved one write is counted)', () => {
    expect(decide(facts('POST', `${APP_ORIGIN}/members`), before)).toEqual(NON_READ);
    expect(decide(facts('POST', `${APP_ORIGIN}/members?draft=1`), before)).toEqual(NON_READ);
    expect(decide(facts('PATCH', `${APP_ORIGIN}/members`), before)).toEqual(NON_READ);
  });

  // OP-REV3（I-1）: 承認した送信先とその下の path を、正規化した形でも除く（比べ方は監査の段の除外の前方一致と同じ部品）。
  it('does not pass a request to the endpoint of the approved send in another path form, nor to a path under it', () => {
    for (const path of ['/members/', '//members', '/MEMBERS', '/Members/', '/%6dembers', '/%2Fmembers', '/members/1', '/members;x', '/a/../members']) {
      expect(decide(facts('POST', `${APP_ORIGIN}${path}`), before), path).toEqual(NON_READ);
    }
    // ほかの Origin の同じ path は、送り先の決まり（許可 Origin と承認したサービスの Origin）で判定する。
    expect(decide(facts('POST', `${SERVICE_ORIGIN}/members-list`), before)).toEqual(PASSED);
  });

  it('stops over the limit of the passes as in the audit stage', () => {
    expect(decide(facts('POST', `${APP_ORIGIN}/rpc/status`), { writeStage: FORM_BEFORE_FILL, auditSend: auditSend(0) }))
      .toEqual({ action: 'BLOCK', category: 'REQUEST', reason: 'AUDIT_SEND_OVER_LIMIT' });
  });

  it('does not pass any non-read request after the values are typed (N1 comes first)', () => {
    const afterFill: PassiveRequestPolicyOptions = { writeStage: FORM_AFTER_FILL, auditSend: auditSend() };
    expect(decide(facts('POST', `${APP_ORIGIN}/rpc/status`, sent()), afterFill)).toEqual(NON_READ);
    expect(decide(facts('POST', `${SERVICE_ORIGIN}/rest/v1/rpc/usage`, sent()), afterFill)).toEqual(NON_READ);
  });

  // OP-REV3（C-2。設計者の判断の案 a）: 押した後は、送信の扱いを当てない（値はヘッダや Cookie でも運べるので、本文と URL の照らしでは足りない）。
  it('does not pass any non-read request after the press (the policy applies only before the values are typed)', () => {
    const afterPress: PassiveRequestPolicyOptions = { writeStage: FORM_AFTER_PRESS, auditSend: auditSend() };
    expect(decide(facts('POST', `${SERVICE_ORIGIN}/rest/v1/rpc/usage`, sent()), afterPress)).toEqual(NON_READ);
    expect(decide(facts('POST', `${APP_ORIGIN}/rpc/status`), afterPress)).toEqual(NON_READ);
    expect(decide(facts('PUT', `${APP_ORIGIN}/rpc/status`), afterPress)).toEqual(NON_READ);
  });

  it('does not pass a WebSocket in the write stage at any time', () => {
    for (const writeStage of [FORM_BEFORE_FILL, FORM_AFTER_FILL, FORM_AFTER_PRESS]) {
      expect(classifyPassiveRequest({ kind: 'WEBSOCKET', url: `wss://${new URL(SERVICE_ORIGIN).host}/realtime` }, ALLOWED_ORIGINS, {
        writeStage, auditSend: auditSend(),
      })).toEqual({ action: 'BLOCK', category: 'WEBSOCKET', reason: 'PASSIVE_WEBSOCKET' });
    }
  });

  it('keeps the read decisions of the write stage (reads outside the allowed Origins stop, as now)', () => {
    expect(decide(facts('GET', `${OTHER_ORIGIN}/widget.js`), before)).toEqual({ action: 'BLOCK', category: 'WRITE_STAGE', reason: 'OUTSIDE_ALLOWED_ORIGINS' });
    expect(decide(facts('GET', `${APP_ORIGIN}/app.js`), before)).toEqual({ action: 'ALLOW', delivery: 'DIRECT' });
  });

  it('does not use the policy together with the login stage (fail-closed, as now)', () => {
    const authSetup = { loginPostEndpoints: [{ origin: APP_ORIGIN, path: '/login' }], remainingPosts: 1 };
    expect(decide(facts('POST', `${APP_ORIGIN}/rpc/status`), { writeStage: FORM_BEFORE_FILL, authSetup, auditSend: auditSend() })).toEqual(NON_READ);
  });

  describe('in the API write stage with the audit stage of a script login audit', () => {
    const API_BEFORE_FILL: WriteStagePolicy = Object.freeze({
      writeEndpoint: Object.freeze({ origin: SERVICE_ORIGIN, path: '/rest/v1/members' }),
      remainingPosts: 0,
      apiOrigin: SERVICE_ORIGIN,
      submissionWindowOpen: false,
    });
    const AUDIT_STAGE: AuditStagePolicy = Object.freeze({
      approvedServiceOrigins: Object.freeze([SERVICE_ORIGIN]),
      auditReadRequests: Object.freeze([]),
      scriptLogin: Object.freeze({ origin: SERVICE_ORIGIN, path: '/auth/v1/token', requiredQuery: Object.freeze([]) }),
    });
    const apiBefore: PassiveRequestPolicyOptions = { writeStage: API_BEFORE_FILL, auditStage: AUDIT_STAGE, auditSend: { ...auditSend(), approvedServiceOrigins: [] } };

    it('passes an unregistered procedure call to the approved service Origin before the values are typed, and not the approved write endpoint', () => {
      expect(decide(facts('POST', `${SERVICE_ORIGIN}/rest/v1/rpc/usage`), apiBefore)).toEqual(PASSED);
      expect(decide(facts('POST', `${SERVICE_ORIGIN}/rest/v1/members`), apiBefore)).toMatchObject(NON_READ);
      expect(decide(facts('POST', `${SERVICE_ORIGIN}/rest/v1/members?select=id`), apiBefore)).toMatchObject(NON_READ);
      expect(decide(facts('POST', `${SERVICE_ORIGIN}/rest/v1/members/`), apiBefore)).toMatchObject(NON_READ);
      expect(decide(facts('POST', `${SERVICE_ORIGIN}/REST/v1//members`), apiBefore)).toMatchObject(NON_READ);
      expect(decide(facts('DELETE', `${SERVICE_ORIGIN}/rest/v1/previews`), apiBefore)).toMatchObject(NON_READ);
    });
  });
});
