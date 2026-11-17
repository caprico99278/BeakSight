// SAFE-2 の 3: 凍結の段でも、監査の段で ADMIT になる登録した読み取りの手続き（読み取りでない method の呼び出し）を通す。判定は凍結の読み取りの判定
// （`isFrozenReadAdmissible`）の中に入れる。読み取りの手続きの登録がない送信・登録した手続きでも形の合わない送信・ログインの段や書き込みの段・危険な語・資格情報・
// main frame の移動は、今どおり凍結で止める。
import { describe, expect, it } from 'vitest';
import { isFrozenReadAdmissible, type HttpRequestFacts, type PassiveRequestPolicyOptions } from '../../src/safety/request-policy.js';

const ORIGIN = 'http://127.0.0.1:4173';
const SERVICE_ORIGIN = 'http://127.0.0.1:5173';
const READ_PATH = '/api/read/list';
const allowedOrigins = new Set([ORIGIN]);

const auditStage = Object.freeze({
  approvedServiceOrigins: [SERVICE_ORIGIN],
  auditReadRequests: [{ origin: SERVICE_ORIGIN, path: READ_PATH, method: 'POST', remainingPosts: 3 }],
  scriptLogin: { origin: SERVICE_ORIGIN, path: '/auth/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },
});
const policy: PassiveRequestPolicyOptions = Object.freeze({ auditStage });

const registeredCall = (change: Partial<HttpRequestFacts> = {}): HttpRequestFacts => ({
  kind: 'HTTP',
  method: 'POST',
  url: `${SERVICE_ORIGIN}${READ_PATH}`,
  isNavigationRequest: false,
  isMainFrame: false,
  resourceType: 'fetch',
  ...change,
});

describe('frozen admission of the registered read procedures', () => {
  it('admits a call of a registered read procedure that the audit stage admits', () => {
    expect(isFrozenReadAdmissible(registeredCall(), allowedOrigins, policy)).toBe(true);
  });

  it.each([
    ['an unregistered POST', registeredCall({ url: `${SERVICE_ORIGIN}/api/write/save` }), policy],
    ['a registered path with another method', registeredCall({ method: 'PUT' }), policy],
    ['a registered call that is not sent by a script', registeredCall({ resourceType: 'document' }), policy],
    ['a registered call as a main frame navigation', registeredCall({ isNavigationRequest: true, isMainFrame: true, resourceType: 'document' }), policy],
    ['a registered call with credentials in the URL', registeredCall({ url: `http://user:secret@127.0.0.1:5173${READ_PATH}` }), policy],
    ['a registered call with a dangerous word', registeredCall({ url: `${SERVICE_ORIGIN}${READ_PATH}?action=delete` }), policy],
    ['a registered call without the audit stage policy', registeredCall(), {}],
    ['a registered call whose budget is used up', registeredCall(), Object.freeze({
      auditStage: { ...auditStage, auditReadRequests: [{ ...auditStage.auditReadRequests[0]!, remainingPosts: 0 }] },
    })],
    ['a registered call to a withheld service origin', registeredCall(), Object.freeze({ auditStage: { ...auditStage, serviceOriginRequestsWithheld: true } })],
  ] as const)('refuses %s', (_label, facts, options) => {
    expect(isFrozenReadAdmissible(facts, allowedOrigins, options as PassiveRequestPolicyOptions)).toBe(false);
  });

  it('keeps admitting the reads (GET) as before', () => {
    expect(isFrozenReadAdmissible(registeredCall({ method: 'GET', url: `${ORIGIN}/data.json` }), allowedOrigins, {})).toBe(true);
  });
});
