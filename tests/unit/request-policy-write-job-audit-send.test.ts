// OP-Q（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.8 の Q1）: 書き込みの作業の中の、送る前の確かめの Context と照合の READ の Context（書き込みの段の口が
// ない Passive の Context）に、監査の段の送信の扱い `PASS_EXCEPT_DELETE` の口を、書き込みの作業の印（`writeJobEndpoint`。承認した送信の送信先）つきで渡したときの、
// 要求の判定（`classifyPassiveRequest`）を表で確かめる。決まりは、書き込みの段の値を入れる前と同じ（要求の判定の owner の 1 か所）。
// - 通す: 許可 Origin と承認したサービスの Origin への、サイトが自動で送る読み取りでない要求（削除と危険な語のほか）。
// - 通さない: 承認した送信の送信先とその下の path（正規化した形を含む。登録が 2 件になるのを防ぐ）、許可 Origin と承認したサービスの Origin のほか、DELETE、
//   危険な語、文書のナビゲーション、WebSocket。
// - 印のない口（監査の段の Passive の Context）は、今どおり（ほかの Origin へも通す。AS-c）。
// 例の値は、匿名の値（`example.com`、`example.invalid`）だけを使う。
import { describe, expect, it } from 'vitest';
import { isGuardAuditSend } from '../../src/safety/passive-request-guard.js';
import {
  classifyPassiveRequest,
  type AuditSendPolicy,
  type HttpRequestFacts,
  type PassiveRequestDecision,
  type PassiveRequestPolicyOptions,
} from '../../src/safety/request-policy.js';

const APP_ORIGIN = 'https://app.example.com';
const SERVICE_ORIGIN = 'https://service.example.invalid';
const OTHER_ORIGIN = 'https://other.example.invalid';
const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([APP_ORIGIN]);
const DANGEROUS_TERMS = Object.freeze(['logout', 'delete']);
const WRITE_ENDPOINT = Object.freeze({ origin: SERVICE_ORIGIN, path: '/rest/v1/members' });

const auditSend = (extra: Partial<AuditSendPolicy> = {}): AuditSendPolicy => ({
  approvedServiceOrigins: [SERVICE_ORIGIN],
  dangerousTerms: DANGEROUS_TERMS,
  remainingPasses: 1,
  remainingWebSockets: 1,
  ...extra,
});

const facts = (method: string, url: string, isNavigationRequest = false): HttpRequestFacts => ({
  kind: 'HTTP', method, url, isNavigationRequest, isMainFrame: isNavigationRequest, resourceType: isNavigationRequest ? 'document' : 'fetch',
});

const decide = (request: HttpRequestFacts, policy: PassiveRequestPolicyOptions): PassiveRequestDecision =>
  classifyPassiveRequest(request, ALLOWED_ORIGINS, policy);

const PASSED = { action: 'ALLOW', delivery: 'DIRECT', auditSendAdmission: true };
const NON_READ = { action: 'BLOCK', category: 'REQUEST', reason: 'NON_READ_METHOD' };

describe('OP-Q (Q1): the audit send policy in the Passive Contexts of a write job', () => {
  const writeJob: PassiveRequestPolicyOptions = { auditSend: auditSend({ writeJobEndpoint: WRITE_ENDPOINT }) };

  it('passes the requests that the site sends by itself, to the test Origin and the approved service Origin', () => {
    expect(decide(facts('POST', `${SERVICE_ORIGIN}/rest/v1/rpc/get_member`), writeJob)).toEqual(PASSED);
    expect(decide(facts('POST', `${APP_ORIGIN}/rpc/status`), writeJob)).toEqual(PASSED);
    expect(decide(facts('PATCH', `${SERVICE_ORIGIN}/rest/v1/media?id=eq.1`), writeJob)).toEqual(PASSED);
  });

  it('does not pass a request to the endpoint of the approved send, nor to a path under it, in any path form (no second registration)', () => {
    for (const path of ['/rest/v1/members', '/rest/v1/members?select=id', '/rest/v1/members/', '/REST/v1//members', '/rest/v1/%6dembers',
      '/rest/v1/members/1', '/rest/v1/members;x', '/rest/v1/a/../members']) {
      expect(decide(facts('POST', `${SERVICE_ORIGIN}${path}`), writeJob), path).toEqual(NON_READ);
    }
    expect(decide(facts('PATCH', `${SERVICE_ORIGIN}/rest/v1/members?id=eq.1`), writeJob)).toEqual(NON_READ);
    // ほかの Origin の同じ path は、送り先の決まり（許可 Origin と承認したサービスの Origin）で判定する。
    expect(decide(facts('POST', `${APP_ORIGIN}/rest/v1/members-list`), writeJob)).toEqual(PASSED);
  });

  it('does not pass a request outside the test and the approved service Origins, a DELETE, a dangerous word, or a navigation', () => {
    expect(decide(facts('POST', `${OTHER_ORIGIN}/collect-post`), writeJob)).toEqual(NON_READ);
    expect(decide(facts('DELETE', `${SERVICE_ORIGIN}/rest/v1/previews?id=eq.1`), writeJob)).toEqual(NON_READ);
    expect(decide(facts('POST', `${APP_ORIGIN}/logout`), writeJob)).toEqual(NON_READ);
    expect(decide(facts('POST', `${APP_ORIGIN}/rpc/status`, true), writeJob)).toMatchObject({ action: 'BLOCK' });
    expect(decide(facts('POST', 'not a url'), writeJob)).toMatchObject({ action: 'BLOCK' });
  });

  it('does not pass a WebSocket', () => {
    expect(classifyPassiveRequest({ kind: 'WEBSOCKET', url: `wss://${new URL(SERVICE_ORIGIN).host}/realtime` }, ALLOWED_ORIGINS, writeJob))
      .toEqual({ action: 'BLOCK', category: 'WEBSOCKET', reason: 'PASSIVE_WEBSOCKET' });
  });

  // OP-R（設計書 4.1.9 の R3。OP-REV5 の C-2）: 承認した送信先の path の型に `{id}`・`[REDACTED]` の区切りがあるときも、区切りごとに比べ、その区切りはどの 1 区切りにも
  // 当てる（その path とその下の path。正規化した形を含む）。OP-REV5 の unit の実験の場面。
  it('does not pass a request to an endpoint whose path shape has an id or a redacted segment, segment by segment (OP-REV5 C-2)', () => {
    const cases: readonly (readonly [string, string, string])[] = [
      ['/api/projects/{id}/members', 'POST', '/api/projects/124/members'],
      ['/api/projects/[REDACTED]/members', 'POST', '/api/projects/124/members'],
      ['/api/members/{id}', 'PATCH', '/api/members/999'],
      ['/api/members/{id}', 'POST', '/api/members/999/copy'],
      ['/api/members/[REDACTED]', 'PATCH', '/api/members/999'],
      ['/api/members/{id}', 'PATCH', '/api/members/%7Bid%7D'],
      ['/api/projects/{id}/members', 'POST', '/API/projects/124//members/'],
      ['/api/projects/{id}/members', 'POST', '/api/projects/%31%32/members/5'],
      ['/api/projects/{id}/members', 'POST', '/api/projects/124/x/../members'],
      ['/api/projects/{id}/members', 'POST', '/api/projects/124;v=1/members'],
    ];
    for (const [path, method, target] of cases) {
      const shaped: PassiveRequestPolicyOptions = { auditSend: auditSend({ writeJobEndpoint: { origin: SERVICE_ORIGIN, path } }) };
      expect(decide(facts(method, `${SERVICE_ORIGIN}${target}`), shaped), `${path} ${method} ${target}`).toEqual(NON_READ);
    }
  });

  it('still passes the requests that do not match the shaped endpoint segment by segment', () => {
    const shaped: PassiveRequestPolicyOptions = { auditSend: auditSend({ writeJobEndpoint: { origin: SERVICE_ORIGIN, path: '/api/projects/{id}/members' } }) };
    // 型の区切りは 1 区切りだけに当たる（2 区切りを飲み込まない）。固定の区切りが違えば当たらない。ほかの Origin の同じ path も当たらない。
    for (const target of ['/api/projects/124/notes', '/api/projects', '/api/projects/124', '/api/projects/1/2/members', '/api/other/124/members']) {
      expect(decide(facts('POST', `${SERVICE_ORIGIN}${target}`), shaped), target).toEqual(PASSED);
    }
    expect(decide(facts('POST', `${APP_ORIGIN}/api/projects/124/members`), shaped)).toEqual(PASSED);
  });

  it('fails closed when the endpoint of the approved send is empty', () => {
    const empty: PassiveRequestPolicyOptions = { auditSend: auditSend({ writeJobEndpoint: { origin: '', path: '' } }) };
    expect(decide(facts('POST', `${SERVICE_ORIGIN}/rest/v1/rpc/get_member`), empty)).toEqual(NON_READ);
  });

  it('keeps the audit stage as now without the write job mark (other Origins and WebSockets pass)', () => {
    const audit: PassiveRequestPolicyOptions = { auditSend: auditSend() };
    expect(decide(facts('POST', `${OTHER_ORIGIN}/collect-post`), audit)).toEqual(PASSED);
    expect(decide(facts('POST', `${SERVICE_ORIGIN}/rest/v1/members`), audit)).toEqual(PASSED);
    expect(classifyPassiveRequest({ kind: 'WEBSOCKET', url: `wss://${new URL(SERVICE_ORIGIN).host}/realtime` }, ALLOWED_ORIGINS, audit))
      .toMatchObject({ action: 'ALLOW' });
  });

  it('accepts the mark in the Guard audit send policy only in the endpoint shape', () => {
    const base = { policy: 'PASS_EXCEPT_DELETE', approvedServiceOrigins: [SERVICE_ORIGIN], dangerousTerms: [...DANGEROUS_TERMS] };
    expect(isGuardAuditSend({ ...base, writeJobEndpoint: WRITE_ENDPOINT })).toBe(true);
    expect(isGuardAuditSend({ ...base, writeJobEndpoint: { origin: SERVICE_ORIGIN } })).toBe(false);
    expect(isGuardAuditSend({ ...base, writeJobEndpoint: 'x' })).toBe(false);
  });
});
