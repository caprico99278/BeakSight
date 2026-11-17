// BN-0（設計書 `doc/design/2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` 3.0）・SD-2（設計書
// `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.4）: 危険な語と読まないパス・読む範囲（`AUDIT_EXCLUDED_URL`）の決まりは、要求の判定
// （`classifyPassiveRequest`）では当てない。main frame の文書の読み込み・ページが出す文書でない GET・HEAD（種類によらない）・子の frame の文書・先読みの
// どれにも、どの Context（Interaction を含む）でも当てない。BeakSight 自身の移動の前と移った画面の判定（`isOutsideAuditScope`）が当てる。
import { describe, expect, it } from 'vitest';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import {
  REQUEST_RESOURCE_TYPES,
  classifyPassiveRequest,
  isOutsideAuditScope,
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
const ALLOW_DIRECT = { action: 'ALLOW', delivery: 'DIRECT' } as const;

/** 除外に当たる URL（危険な語、読まないパス、読む範囲の外）。 */
const EXCLUDED_URLS = Object.freeze([
  `${ORIGIN}/admin/assets/delete-helper.js`,
  `${ORIGIN}/private/data.json`,
  `${ORIGIN}/api/items`,
]);

const subresource = (url: string, resourceType: RequestResourceType, method = 'GET'): HttpRequestFacts =>
  ({ kind: 'HTTP', method, url, isNavigationRequest: false, isMainFrame: false, resourceType });

describe('SD-2: the request policy applies no audit stage exclusion, and the scope check of the own moves does', () => {
  it.each(EXCLUDED_URLS)('lets the main frame document load of %s through, and finds it outside the scope', (url) => {
    expect(classifyPassiveRequest({ kind: 'HTTP', method: 'GET', url, isNavigationRequest: true, isMainFrame: true, resourceType: 'document' }, ALLOWED, {
      auditExclusions: EXCLUSIONS,
    })).toEqual({ action: 'ALLOW', delivery: 'INSPECT_REDIRECTS' });
    expect(isOutsideAuditScope(url, ALLOWED, EXCLUSIONS)).toBe(true);
  });

  it.each(EXCLUDED_URLS)('lets the page reads of %s through: every resource type, an unknown type, a child frame document and a prefetch', (url) => {
    const facts: readonly HttpRequestFacts[] = [
      ...REQUEST_RESOURCE_TYPES.flatMap((resourceType) => [subresource(url, resourceType), subresource(url, resourceType, 'HEAD')]),
      { kind: 'HTTP', method: 'GET', url, isNavigationRequest: false, isMainFrame: false },
      { kind: 'HTTP', method: 'GET', url, isNavigationRequest: true, isMainFrame: false, resourceType: 'document' },
      { ...subresource(url, 'other'), sentContent: { headers: { 'Sec-Purpose': 'prefetch' }, formMethodOverrides: () => [] } },
    ];
    for (const fact of facts) {
      expect(classifyPassiveRequest(fact, ALLOWED, { auditExclusions: EXCLUSIONS })).toEqual(ALLOW_DIRECT);
    }
  });
});
