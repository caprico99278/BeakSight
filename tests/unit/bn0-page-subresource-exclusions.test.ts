// BN-0（設計書 `doc/design/2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` 3.0。ユーザーの判断 2026-10-23）: 監査の段の Passive の Context では、
// ページが出す文書でない GET・HEAD に、危険な語と読まないパス・読む範囲（`AUDIT_EXCLUDED_URL`）の決まりを当てない（判定の owner `classifyPassiveRequest`）。
// - 今どおり当てる: BeakSight 自身の移動と文書の読み込み（main frame と子の frame）、読み取りでない送信、Interaction の Context（印
//   `applyToPageSubresourceReads`）、ログインの段・書き込みの段。
// - 「文書でない」の見分けは 1 か所（`isPageSubresourceRead`）。種類の分からない要求は当てる側（fail-closed）。
import { describe, expect, it } from 'vitest';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import {
  REQUEST_RESOURCE_TYPES,
  classifyPassiveRequest,
  isPageSubresourceRead,
  type AuditExclusionPolicy,
  type HttpRequestFacts,
  type RequestResourceType,
} from '../../src/safety/request-policy.js';

const ORIGIN = 'https://example.com';
const ALLOWED: ReadonlySet<string> = new Set([ORIGIN]);
const EXCLUSIONS: AuditExclusionPolicy = Object.freeze({
  excludedPathPrefixes: Object.freeze(['/private']),
  auditPathPrefixes: Object.freeze(['/admin']),
  dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS,
});
const INTERACTION_EXCLUSIONS: AuditExclusionPolicy = Object.freeze({ ...EXCLUSIONS, applyToPageSubresourceReads: true });
const BLOCK_EXCLUDED = { action: 'BLOCK', category: 'AUDIT_EXCLUSION', reason: 'AUDIT_EXCLUDED_URL' } as const;
const ALLOW_DIRECT = { action: 'ALLOW', delivery: 'DIRECT' } as const;

/** 除外に当たる URL（危険な語、読まないパス、読む範囲の外）。 */
const EXCLUDED_URLS = Object.freeze([
  `${ORIGIN}/admin/assets/delete-helper.js`,
  `${ORIGIN}/private/data.json`,
  `${ORIGIN}/api/items`,
]);

const subresource = (url: string, resourceType: RequestResourceType, method = 'GET'): HttpRequestFacts =>
  ({ kind: 'HTTP', method, url, isNavigationRequest: false, isMainFrame: false, resourceType });

describe('BN-0: the page subresource reads are not judged with the audit stage exclusions in a Passive context', () => {
  it.each(EXCLUDED_URLS.flatMap((url) => (['script', 'stylesheet', 'image', 'font', 'media', 'fetch', 'xhr', 'other'] as const)
    .flatMap((resourceType) => [['GET', url, resourceType], ['HEAD', url, resourceType]] as const)))(
    'lets a page %s of %s (%s) through', (method, url, resourceType) => {
      expect(classifyPassiveRequest(subresource(url, resourceType, method), ALLOWED, { auditExclusions: EXCLUSIONS })).toEqual(ALLOW_DIRECT);
    },
  );

  it.each(EXCLUDED_URLS)('still stops the main frame and the child frame document loads of %s', (url) => {
    expect(classifyPassiveRequest({ kind: 'HTTP', method: 'GET', url, isNavigationRequest: true, isMainFrame: true, resourceType: 'document' }, ALLOWED, {
      auditExclusions: EXCLUSIONS,
    })).toEqual(BLOCK_EXCLUDED);
    expect(classifyPassiveRequest({ kind: 'HTTP', method: 'GET', url, isNavigationRequest: true, isMainFrame: false, resourceType: 'document' }, ALLOWED, {
      auditExclusions: EXCLUSIONS,
    })).toEqual(BLOCK_EXCLUDED);
  });

  it.each(EXCLUDED_URLS)('still stops a page subresource read of %s in the Interaction context', (url) => {
    expect(classifyPassiveRequest(subresource(url, 'fetch'), ALLOWED, { auditExclusions: INTERACTION_EXCLUSIONS })).toEqual(BLOCK_EXCLUDED);
    expect(classifyPassiveRequest(subresource(url, 'script'), ALLOWED, { auditExclusions: INTERACTION_EXCLUSIONS })).toEqual(BLOCK_EXCLUDED);
  });

  it('still stops a request of an unknown resource type (fail-closed) and a non-navigation document', () => {
    expect(classifyPassiveRequest({ kind: 'HTTP', method: 'GET', url: EXCLUDED_URLS[1] ?? '', isNavigationRequest: false, isMainFrame: false }, ALLOWED, {
      auditExclusions: EXCLUSIONS,
    })).toEqual(BLOCK_EXCLUDED);
    expect(classifyPassiveRequest(subresource(EXCLUDED_URLS[1] ?? '', 'document'), ALLOWED, { auditExclusions: EXCLUSIONS })).toEqual(BLOCK_EXCLUDED);
  });

  it('keeps the rule of the non-read requests (a POST to an excluded URL is still blocked)', () => {
    expect(classifyPassiveRequest(subresource(EXCLUDED_URLS[0] ?? '', 'fetch', 'POST'), ALLOWED, { auditExclusions: EXCLUSIONS }))
      .toEqual({ action: 'BLOCK', category: 'REQUEST', reason: 'NON_READ_METHOD' });
  });

  it('keeps the Origin rule (an allowed subresource read outside the allowed origins is unchanged)', () => {
    expect(classifyPassiveRequest(subresource('https://other.example/private/x.js', 'script'), ALLOWED, { auditExclusions: EXCLUSIONS })).toEqual(ALLOW_DIRECT);
  });

  it('judges a page subresource read in one place from the request facts', () => {
    // BN-R0 fix round 1: 文書の先回り（`prefetch`・`signedexchange`）も、文書でない読み取りとして扱わない（除外を当てる）。
    const documentLike: readonly string[] = ['document', 'prefetch', 'signedexchange'];
    for (const resourceType of REQUEST_RESOURCE_TYPES) {
      expect(isPageSubresourceRead(subresource(`${ORIGIN}/a`, resourceType))).toBe(!documentLike.includes(resourceType));
    }
    // BN-R0 fix round 1: 先読みの印のヘッダ（`Sec-Purpose`・`Purpose` の `prefetch`）のある要求は、種類が `other` でも文書の先回りとして扱う。
    for (const headers of [{ 'Sec-Purpose': 'prefetch' }, { 'sec-purpose': 'prefetch;prerender' }, { Purpose: 'prefetch' }]) {
      expect(isPageSubresourceRead({ ...subresource(`${ORIGIN}/a`, 'other'), sentContent: { headers, formMethodOverrides: () => [] } })).toBe(false);
    }
    expect(classifyPassiveRequest({ ...subresource(EXCLUDED_URLS[0] ?? '', 'other'), sentContent: { headers: { 'Sec-Purpose': 'prefetch' }, formMethodOverrides: () => [] } },
      ALLOWED, { auditExclusions: EXCLUSIONS })).toEqual(BLOCK_EXCLUDED);
    expect(isPageSubresourceRead(subresource(`${ORIGIN}/a`, 'fetch', 'POST'))).toBe(false);
    expect(isPageSubresourceRead({ ...subresource(`${ORIGIN}/a`, 'fetch'), isNavigationRequest: true })).toBe(false);
    expect(isPageSubresourceRead({ kind: 'HTTP', method: 'GET', url: `${ORIGIN}/a`, isNavigationRequest: false, isMainFrame: false })).toBe(false);
  });
});
