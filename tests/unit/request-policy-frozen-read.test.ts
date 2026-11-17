// DEF-208-1（設計書 `2026-11-05-beaksight-discovery-coverage-design.md` 3.1 と、Blocker の後の設計者の判断）: 凍結の読み取りの判定
// `isFrozenReadAdmissible`（凍結の段で、監査の段の判定にかけてよい読み取りか。判定の唯一の場所）。
import { describe, expect, it } from 'vitest';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { isFrozenReadAdmissible, type HttpRequestFacts, type PassiveRequestPolicyOptions } from '../../src/safety/request-policy.js';

const APP = 'https://app.example.test';
const API = 'https://api.example.test';
const OTHER = 'https://other.example.test';
const ALLOWED: ReadonlySet<string> = new Set([APP]);

const POLICY: PassiveRequestPolicyOptions = {
  auditSend: { approvedServiceOrigins: [API], dangerousTerms: [...DEFAULT_EXCLUDED_URL_WORDS, 'sign_out'] },
  auditExclusions: { excludedPathPrefixes: ['/private'], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
};

const fetchFacts = (method: string, url: string): HttpRequestFacts =>
  ({ kind: 'HTTP', method, url, isNavigationRequest: false, isMainFrame: false, resourceType: 'fetch' });

describe('DEF-208-1: isFrozenReadAdmissible', () => {
  it('admits GET and HEAD to the allowed origins and the approved service origins', () => {
    expect(isFrozenReadAdmissible(fetchFacts('GET', `${APP}/items`), ALLOWED, POLICY)).toBe(true);
    expect(isFrozenReadAdmissible(fetchFacts('HEAD', `${API}/rest/items?slug=x`), ALLOWED, POLICY)).toBe(true);
    expect(isFrozenReadAdmissible(fetchFacts('get', `${API}/rest/items`), ALLOWED, POLICY)).toBe(true);
  });

  it('never admits a request that is not a read (the writes stay frozen)', () => {
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS']) {
      expect(isFrozenReadAdmissible(fetchFacts(method, `${APP}/items`), ALLOWED, POLICY)).toBe(false);
    }
  });

  it('keeps the main frame navigation frozen and admits a child frame document read', () => {
    const navigation = { ...fetchFacts('GET', `${APP}/next`), isNavigationRequest: true, resourceType: 'document' as const };
    expect(isFrozenReadAdmissible({ ...navigation, isMainFrame: true }, ALLOWED, POLICY)).toBe(false);
    expect(isFrozenReadAdmissible({ ...navigation, isMainFrame: false }, ALLOWED, POLICY)).toBe(true);
  });

  it('does not admit another origin, a dangerous term, an excluded path, credentials or a non-http URL', () => {
    expect(isFrozenReadAdmissible(fetchFacts('GET', `${OTHER}/items`), ALLOWED, POLICY)).toBe(false);
    expect(isFrozenReadAdmissible(fetchFacts('GET', `${API}/auth/logout`), ALLOWED, POLICY)).toBe(false);
    expect(isFrozenReadAdmissible(fetchFacts('GET', `${API}/x?next=sign_out`), ALLOWED, POLICY)).toBe(false);
    expect(isFrozenReadAdmissible(fetchFacts('GET', `${APP}/private/rows`), ALLOWED, POLICY)).toBe(false);
    expect(isFrozenReadAdmissible(fetchFacts('GET', 'https://user:secret@app.example.test/items'), ALLOWED, POLICY)).toBe(false);
    expect(isFrozenReadAdmissible(fetchFacts('GET', 'ftp://app.example.test/items'), ALLOWED, POLICY)).toBe(false);
    expect(isFrozenReadAdmissible(fetchFacts('GET', 'not a url'), ALLOWED, POLICY)).toBe(false);
  });

  it('applies the default dangerous terms without the audit send policy (READ_ONLY)', () => {
    expect(isFrozenReadAdmissible(fetchFacts('GET', `${APP}/items`), ALLOWED, {})).toBe(true);
    expect(isFrozenReadAdmissible(fetchFacts('GET', `${APP}/logout`), ALLOWED, {})).toBe(false);
    expect(isFrozenReadAdmissible(fetchFacts('GET', `${API}/items`), ALLOWED, {})).toBe(false);
  });

  it('does not admit the service origin of a context that withholds the service origin requests', () => {
    const withheld: PassiveRequestPolicyOptions = {
      ...POLICY,
      auditStage: {
        approvedServiceOrigins: [API],
        auditReadRequests: [],
        scriptLogin: { origin: API, path: '/token', requiredQuery: [] },
        serviceOriginRequestsWithheld: true,
      },
    };
    expect(isFrozenReadAdmissible(fetchFacts('GET', `${API}/rest/items`), ALLOWED, withheld)).toBe(false);
    expect(isFrozenReadAdmissible(fetchFacts('GET', `${APP}/items`), ALLOWED, withheld)).toBe(true);
  });
});
