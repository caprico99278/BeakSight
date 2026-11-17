// SREV-SAFE の C-1・I-2 と SD-2（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.1・2.4）: 削除の上書き（本文の `_method=DELETE`・ヘッダの
// `X-HTTP-Method-Override: DELETE`・JSON の最上位の `_method`）と危険な語は、監査の段の判定（`classifyPassiveRequest`）では止めない（サイト自身の通信）。凍結の
// 読み取りの判定（`isFrozenReadAdmissible`。守り 2）は、登録した読み取りの手続きの呼び出しでも、読み取り（GET・HEAD）に付いたヘッダの上書きでも、今どおり通さない。
import { describe, expect, it } from 'vitest';
import {
  classifyPassiveRequest,
  isFrozenReadAdmissible,
  type AuditStagePolicy,
  type HttpRequestFacts,
  type PassiveRequestPolicyOptions,
} from '../../src/safety/request-policy.js';
import { formMethodOverrideValuesOf } from '../../src/safety/write-payload-policy.js';

const APP_ORIGIN = 'https://example.com';
const SERVICE_ORIGIN = 'https://service.example.invalid';
const ALLOWED: ReadonlySet<string> = new Set([APP_ORIGIN]);
const RPC = `${SERVICE_ORIGIN}/rest/v1/rpc/list_members`;
const PAGE_READ = `${APP_ORIGIN}/admin/list.json`;

const STAGE: AuditStagePolicy = {
  approvedServiceOrigins: [SERVICE_ORIGIN],
  auditReadRequests: [{ origin: SERVICE_ORIGIN, path: '/rest/v1/rpc/list_members', method: 'POST', remainingPosts: 1 }],
  scriptLogin: { origin: SERVICE_ORIGIN, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },
};
const POLICY: PassiveRequestPolicyOptions = { auditStage: STAGE };

const request = (method: string, url: string, headers: Record<string, string>, body: string | null): HttpRequestFacts => ({
  kind: 'HTTP', method, url, isNavigationRequest: false, isMainFrame: false, resourceType: 'fetch',
  sentContent: { headers, formMethodOverrides: () => formMethodOverrideValuesOf(headers, () => (body === null ? { kind: 'NONE' } : { kind: 'TEXT', text: body })) },
});

const OVERRIDES = [
  ['the body _method', { 'content-type': 'application/x-www-form-urlencoded' }, '_method=DELETE'],
  ['the header', { 'content-type': 'application/json', 'x-http-method-override': 'DELETE' }, '{}'],
  ['the top-level JSON _method', { 'content-type': 'application/json' }, '{"_method":"DELETE"}'],
] as const;

describe('a delete override and a dangerous term pass in the audit stage, and stay out of the frozen reads (SD-2, guard 2)', () => {
  it('admits the registered read procedure without an override (control)', () => {
    const call = request('POST', RPC, { 'content-type': 'application/json' }, '{}');
    expect(classifyPassiveRequest(call, ALLOWED, POLICY).action).toBe('ALLOW');
    expect(isFrozenReadAdmissible(call, ALLOWED, POLICY)).toBe(true);
  });

  it.each(OVERRIDES)('admits the registered read procedure with %s DELETE in the audit stage, and not while frozen', (_name, headers, body) => {
    const call = request('POST', RPC, { ...headers }, body);
    expect(classifyPassiveRequest(call, ALLOWED, POLICY).action).toBe('ALLOW');
    expect(isFrozenReadAdmissible(call, ALLOWED, POLICY)).toBe(false);
  });

  it('admits a registered call with a dangerous term in the audit stage, and not while frozen', () => {
    const call = request('POST', `${RPC}?op=delete`, { 'content-type': 'application/json' }, '{}');
    const excluding: PassiveRequestPolicyOptions = { ...POLICY, auditExclusions: { excludedPathPrefixes: [], auditPathPrefixes: [], dangerousTerms: ['delete'] } };
    expect(classifyPassiveRequest(call, ALLOWED, excluding).action).toBe('ALLOW');
    expect(isFrozenReadAdmissible(call, ALLOWED, POLICY)).toBe(false);
  });

  it.each(['GET', 'HEAD'])('passes a %s read with the header override DELETE in the audit stage, and not while frozen', (method) => {
    const read = request(method, PAGE_READ, { 'x-http-method-override': 'DELETE' }, null);
    expect(classifyPassiveRequest(read, ALLOWED, {}).action).toBe('ALLOW');
    expect(classifyPassiveRequest(read, ALLOWED, POLICY).action).toBe('ALLOW');
    expect(isFrozenReadAdmissible(read, ALLOWED, POLICY)).toBe(false);
    expect(isFrozenReadAdmissible(request(method, PAGE_READ, {}, null), ALLOWED, POLICY)).toBe(true);
  });
});
