import { describe, expect, it } from 'vitest';
import {
  CROSS_PAGE_RULES,
  evaluateCrossPageRules,
  type CrossPagePageResult,
  type CrossPageRule,
  type CrossPageRuleInput,
  type CrossPageViewportResult,
} from '../../src/audit/cross-page-rules.js';
import { RULE_CATALOG } from '../../src/audit/rule-catalog.js';
import {
  VIEWPORT_PROFILES,
  type EvidenceId,
  type EvidenceRecord,
  type Finding,
  type ViewportProfile,
} from '../../src/core/contracts.js';
import type {
  DomEvidence,
  LinkEvidence,
  NavigationOutcomeKind,
  NetworkEvidence,
  NormalizedHttpUrlEvidence,
  SitemapEvidence,
} from '../../src/core/evidence-types.js';
import { createEvidenceId, createFindingFingerprint, createFindingId, createPageId } from '../../src/core/ids.js';
import { classifyUrl } from '../../src/crawl/admission-policy.js';
import { normalizeUrl } from '../../src/crawl/normalize-url.js';

const TARGET_ID = 'cross-page-fixture-target';
const ORIGIN = 'http://127.0.0.1:4173';
/** 許可Originの外（ポートが異なる）。 */
const OTHER_ORIGIN = 'http://127.0.0.1:4999';
/** ORIGIN の https 版（http から https へのリダイレクトを表すため）。 */
const HTTPS_ORIGIN = 'https://127.0.0.1:4173';
const OBSERVED_AT = '2026-09-24T00:00:00.000Z';
/**
 * クロールで残すクエリのパラメータ（ページングの URL を別のページとして扱うため）。
 * `ref` は、同じ文書へ別の URL でリダイレクトする場面（`/p` と `/p?ref=a`）を表すために残す。
 */
const ALLOWED_QUERY_PARAMETERS: readonly string[] = ['page', 'ref'];

const pageUrlOf = (path: string): NormalizedHttpUrlEvidence => {
  const normalized = normalizeUrl(path, `${ORIGIN}/`, new Set(ALLOWED_QUERY_PARAMETERS));
  if (!normalized.ok) {
    throw new Error(`test page url must be normalizable: ${path}`);
  }
  return normalized.url;
};

interface ViewportSpec {
  readonly httpStatus: number | null;
  readonly finalUrl?: string | null;
  readonly navigationFailed?: boolean;
  readonly skipped?: boolean;
  /** 省略すると、スキップなら null、`navigationFailed` なら FAILED、それ以外は OK。 */
  readonly navigationOutcome?: NavigationOutcomeKind;
}

interface LinkSpec {
  readonly href: string;
  readonly text?: string;
}

interface PageSpec {
  readonly sequence: number;
  readonly path: string;
  readonly title?: string | null;
  readonly titleTruncated?: boolean;
  readonly canonical?: string | null;
  readonly headings?: readonly string[];
  readonly links?: readonly LinkSpec[];
  readonly viewports?: Partial<Record<ViewportProfile, ViewportSpec>>;
}

const OK_VIEWPORT: ViewportSpec = { httpStatus: 200 };
const NAVIGATION_FAILED_VIEWPORT: ViewportSpec = { httpStatus: null, navigationFailed: true };
const SKIPPED_VIEWPORT: ViewportSpec = { httpStatus: null, skipped: true };
/** ナビゲーションが期限を過ぎた（応答を観測できず、最終URLもない）。 */
const TIMEOUT_VIEWPORT: ViewportSpec = { httpStatus: null, navigationFailed: true, navigationOutcome: 'TIMEOUT' };
/** 許可Originの外へのリダイレクトを Guard が遮断し、ナビゲーションが失敗した。 */
const BLOCKED_REDIRECT_VIEWPORT: ViewportSpec = {
  httpStatus: null,
  navigationFailed: true,
  navigationOutcome: 'BLOCKED_EXTERNAL_REDIRECT',
};

const evidenceSequence = (spec: PageSpec, viewport: ViewportProfile): number =>
  spec.sequence * 10 + VIEWPORT_PROFILES.indexOf(viewport);

const domEvidenceId = (spec: PageSpec, viewport: ViewportProfile): EvidenceId =>
  createEvidenceId('dom', evidenceSequence(spec, viewport));
const linkEvidenceId = (spec: PageSpec, viewport: ViewportProfile): EvidenceId =>
  createEvidenceId('link', evidenceSequence(spec, viewport));
const networkEvidenceId = (spec: PageSpec, viewport: ViewportProfile): EvidenceId =>
  createEvidenceId('network', evidenceSequence(spec, viewport));

const linkEvidence = (spec: PageSpec, link: LinkSpec): LinkEvidence => {
  const pageUrl = pageUrlOf(spec.path);
  const normalized = normalizeUrl(link.href, pageUrl, new Set(ALLOWED_QUERY_PARAMETERS));
  return {
    sourcePageId: createPageId(spec.sequence),
    anchorText: link.text ?? '',
    ariaLabel: null,
    title: null,
    rawHref: link.href,
    normalized,
    admission: normalized.ok
      ? classifyUrl(new URL(normalized.url), { allowedOrigins: new Set([ORIGIN]) })
      : { kind: 'REJECTED_INVALID', rawUrl: normalized.rawUrl, reason: normalized.reason },
    truncated: false,
  };
};

const domEvidence = (spec: PageSpec): DomEvidence => ({
  pageId: createPageId(spec.sequence),
  scrollPosition: { scrollX: 0, scrollY: 0 },
  title: spec.title === undefined ? `ページ ${spec.path}` : spec.title,
  metaDescription: null,
  canonicalUrl: spec.canonical ?? null,
  lang: 'ja',
  headings: (spec.headings ?? []).map((text) => ({ level: 2, text, truncated: false })),
  // Cross-page rule は、可視テキスト・画像・form を読まない。
  visibleText: {} as DomEvidence['visibleText'],
  images: [],
  forms: [],
  unassociatedFields: [],
  duplicateIds: [],
  truncation: {
    documentFields: { title: spec.titleTruncated ?? false, metaDescription: false, canonicalUrl: false, lang: false },
    omittedHeadingCount: 0,
    omittedImageCount: 0,
    omittedFormCount: 0,
    omittedUnassociatedFieldCount: 0,
    omittedDuplicateIdCount: 0,
  },
});

const viewportResult = (spec: PageSpec, viewport: ViewportProfile): CrossPageViewportResult => {
  const pageUrl = pageUrlOf(spec.path);
  const viewportSpec = spec.viewports?.[viewport] ?? OK_VIEWPORT;
  if (viewportSpec.skipped === true) {
    return {
      requestedUrl: pageUrl,
      finalUrl: null,
      httpStatus: null,
      status: 'SKIPPED',
      incompleteReasons: [],
      navigationOutcome: null,
    };
  }
  if (viewportSpec.navigationFailed === true) {
    return {
      requestedUrl: pageUrl,
      finalUrl: viewportSpec.finalUrl ?? null,
      httpStatus: null,
      status: 'FAILED',
      incompleteReasons: [{ code: 'NAVIGATION_FAILED', detail: 'net::ERR_CONNECTION_REFUSED' }],
      navigationOutcome: viewportSpec.navigationOutcome ?? 'FAILED',
    };
  }
  return {
    requestedUrl: pageUrl,
    finalUrl: viewportSpec.finalUrl === undefined ? pageUrl : viewportSpec.finalUrl,
    httpStatus: viewportSpec.httpStatus,
    status: 'AUDITED',
    incompleteReasons: [],
    navigationOutcome: viewportSpec.navigationOutcome ?? 'OK',
  };
};

const page = (spec: PageSpec): CrossPagePageResult => {
  const pageId = createPageId(spec.sequence);
  const evidence: EvidenceRecord[] = [];
  for (const viewport of VIEWPORT_PROFILES) {
    const result = viewportResult(spec, viewport);
    if (result.status === 'SKIPPED') {
      continue;
    }
    // network の collector は、ナビゲーションの前に取り付ける。そのため、ナビゲーションが失敗しても network の Evidence はある。
    evidence.push({
      evidenceId: networkEvidenceId(spec, viewport),
      type: 'network',
      pageId,
      viewport,
      observedAt: OBSERVED_AT,
      // Cross-page rule は network の payload を読まない（参照に使うだけ）。
      payload: {} as NetworkEvidence,
    });
    if (result.httpStatus === null) {
      continue;
    }
    evidence.push(
      {
        evidenceId: domEvidenceId(spec, viewport),
        type: 'dom',
        pageId,
        viewport,
        observedAt: OBSERVED_AT,
        payload: domEvidence(spec),
      },
      {
        evidenceId: linkEvidenceId(spec, viewport),
        type: 'link',
        pageId,
        viewport,
        observedAt: OBSERVED_AT,
        payload: { links: (spec.links ?? []).map((link) => linkEvidence(spec, link)), omittedLinkCount: 0 },
      },
    );
  }
  return {
    pageId,
    pageUrl: pageUrlOf(spec.path),
    viewports: { desktop: viewportResult(spec, 'desktop'), mobile: viewportResult(spec, 'mobile') },
    evidence,
  };
};

const SITEMAP_EVIDENCE_ID = createEvidenceId('metadata', 1);

const sitemap = (paths: readonly string[], truncated = false): SitemapEvidence => ({
  evidenceId: SITEMAP_EVIDENCE_ID,
  urls: paths.map((path) => (path.startsWith('http') ? path : `${ORIGIN}${path}`)),
  truncated,
});

const evaluate = (
  pages: readonly CrossPagePageResult[],
  overrides: Partial<CrossPageRuleInput> = {},
): ReturnType<typeof evaluateCrossPageRules> =>
  evaluateCrossPageRules({
    targetId: TARGET_ID,
    firstFindingSequence: 0,
    allowedOrigins: [ORIGIN],
    allowedQueryParameters: ALLOWED_QUERY_PARAMETERS,
    pages,
    ...overrides,
  });

const findingsOf = (result: ReturnType<typeof evaluateCrossPageRules>, ruleId: string): readonly Finding[] =>
  result.findings.filter((finding) => finding.ruleId === ruleId);

const EXPECTED_RULES = [
  { ruleId: 'BROKEN_INTERNAL_LINK', category: 'LINK', severity: 'ERROR' },
  { ruleId: 'TARGET_NAVIGATION_FAILED', category: 'LINK', severity: 'ERROR' },
  { ruleId: 'DUPLICATE_PAGE_TITLE', category: 'CROSS_PAGE', severity: 'WARN' },
  { ruleId: 'DUPLICATE_CANONICAL', category: 'CROSS_PAGE', severity: 'WARN' },
  { ruleId: 'MULTIPLE_URLS_SAME_CANONICAL', category: 'CROSS_PAGE', severity: 'INFO' },
  { ruleId: 'CANONICAL_TARGET_NOT_FOUND', category: 'CROSS_PAGE', severity: 'WARN' },
  { ruleId: 'INCONSISTENT_ORIGIN', category: 'CROSS_PAGE', severity: 'WARN' },
  { ruleId: 'SITEMAP_URL_NOT_DISCOVERED', category: 'CROSS_PAGE', severity: 'INFO' },
  { ruleId: 'DISCOVERED_URL_NOT_IN_SITEMAP', category: 'CROSS_PAGE', severity: 'INFO' },
  { ruleId: 'NAVIGATION_TIMEOUT', category: 'HTTP', severity: 'ERROR' },
  { ruleId: 'UNEXPECTED_ORIGIN_REDIRECT', category: 'HTTP', severity: 'WARN' },
] as const;

describe('CROSS_PAGE_RULES', () => {
  it('registers every cross-page rule of design chapter 7 once with its category and severity', () => {
    expect(
      CROSS_PAGE_RULES.map(({ ruleId, category, severity }) => ({ ruleId, category, severity })),
    ).toEqual(expect.arrayContaining(EXPECTED_RULES.map((rule) => ({ ...rule }))));
    expect(CROSS_PAGE_RULES).toHaveLength(EXPECTED_RULES.length);
    expect(new Set(CROSS_PAGE_RULES.map((rule) => rule.ruleId)).size).toBe(CROSS_PAGE_RULES.length);
    for (const rule of CROSS_PAGE_RULES) {
      expect(Number.isSafeInteger(rule.version) && rule.version > 0).toBe(true);
    }
    expect(Object.isFrozen(CROSS_PAGE_RULES)).toBe(true);
  });

  it('does not reuse a page rule id', () => {
    const pageRuleIds = new Set(RULE_CATALOG.map((rule) => rule.ruleId));
    for (const rule of CROSS_PAGE_RULES) {
      expect(pageRuleIds.has(rule.ruleId)).toBe(false);
    }
  });
});

describe('evaluateCrossPageRules: internal links', () => {
  it('reports BROKEN_INTERNAL_LINK when an audited link target answered 4xx or 5xx', () => {
    const result = evaluate([
      page({ sequence: 1, path: '/', links: [{ href: '/missing', text: '詳細' }, { href: '/error' }] }),
      page({ sequence: 2, path: '/missing', viewports: { desktop: { httpStatus: 404 }, mobile: { httpStatus: 404 } } }),
      page({ sequence: 3, path: '/error', viewports: { desktop: { httpStatus: 503 }, mobile: { httpStatus: 200 } } }),
    ]);

    const findings = findingsOf(result, 'BROKEN_INTERNAL_LINK');
    expect(findings).toHaveLength(2);
    for (const finding of findings) {
      expect(finding).toMatchObject({
        category: 'LINK',
        severity: 'ERROR',
        pageId: createPageId(1),
        pageUrl: pageUrlOf('/'),
        viewport: null,
      });
      expect(finding.evidenceRefs).toEqual(
        [linkEvidenceId({ sequence: 1, path: '/' }, 'desktop'), linkEvidenceId({ sequence: 1, path: '/' }, 'mobile')].sort(),
      );
    }
    const missing = findings.find((finding) => finding.message.includes(pageUrlOf('/missing')));
    expect(missing?.message).toContain('404');
    expect(missing?.message).toContain(pageUrlOf('/'));
    const error = findings.find((finding) => finding.message.includes(pageUrlOf('/error')));
    expect(error?.message).toContain('503');
    expect(result.unverifiedInternalLinkCount).toBe(0);
  });

  it('does not report BROKEN_INTERNAL_LINK when the link target answered 2xx or 3xx', () => {
    const result = evaluate([
      page({ sequence: 1, path: '/', links: [{ href: '/ok' }, { href: '/moved' }, { href: `${OTHER_ORIGIN}/gone` }] }),
      page({ sequence: 2, path: '/ok' }),
      page({ sequence: 3, path: '/moved', viewports: { desktop: { httpStatus: 304 }, mobile: { httpStatus: 200 } } }),
    ]);

    expect(findingsOf(result, 'BROKEN_INTERNAL_LINK')).toEqual([]);
    expect(findingsOf(result, 'TARGET_NAVIGATION_FAILED')).toEqual([]);
  });

  it('reports TARGET_NAVIGATION_FAILED when navigating to an internal link target failed', () => {
    const result = evaluate([
      page({ sequence: 1, path: '/', links: [{ href: '/unreachable' }] }),
      page({
        sequence: 2,
        path: '/unreachable',
        viewports: { desktop: NAVIGATION_FAILED_VIEWPORT, mobile: NAVIGATION_FAILED_VIEWPORT },
      }),
    ]);

    const findings = findingsOf(result, 'TARGET_NAVIGATION_FAILED');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ category: 'LINK', severity: 'ERROR', pageId: createPageId(1), viewport: null });
    expect(findings[0]?.message).toContain(pageUrlOf('/unreachable'));
    expect(findingsOf(result, 'BROKEN_INTERNAL_LINK')).toEqual([]);
    expect(result.unverifiedInternalLinkCount).toBe(0);
  });

  it('reports TARGET_NAVIGATION_FAILED for a single failed viewport and not when every viewport produced a response', () => {
    const result = evaluate([
      page({ sequence: 1, path: '/', links: [{ href: '/reachable' }] }),
      page({ sequence: 2, path: '/reachable', viewports: { desktop: NAVIGATION_FAILED_VIEWPORT } }),
    ]);

    // mobile で応答を観測できた場合も、desktop のナビゲーションの失敗は事実として報告する。
    expect(findingsOf(result, 'TARGET_NAVIGATION_FAILED')).toHaveLength(1);

    const healthy = evaluate([
      page({ sequence: 1, path: '/', links: [{ href: '/reachable' }] }),
      page({ sequence: 2, path: '/reachable' }),
    ]);
    expect(findingsOf(healthy, 'TARGET_NAVIGATION_FAILED')).toEqual([]);
  });

  it('does not report TARGET_NAVIGATION_FAILED for a /login link redirected to an external SSO, which UNEXPECTED_ORIGIN_REDIRECT alone reports', () => {
    const result = evaluate([
      page({ sequence: 1, path: '/', links: [{ href: '/login', text: 'ログイン' }] }),
      page({ sequence: 2, path: '/login', viewports: { desktop: BLOCKED_REDIRECT_VIEWPORT, mobile: BLOCKED_REDIRECT_VIEWPORT } }),
    ]);

    expect(findingsOf(result, 'TARGET_NAVIGATION_FAILED')).toEqual([]);
    const redirects = findingsOf(result, 'UNEXPECTED_ORIGIN_REDIRECT');
    expect(redirects).toHaveLength(1);
    expect(redirects[0]).toMatchObject({ pageId: createPageId(2), pageUrl: pageUrlOf('/login') });
    expect(result.unverifiedInternalLinkCount).toBe(0);
  });

  it('does not report TARGET_NAVIGATION_FAILED for a link target whose navigation timed out, which NAVIGATION_TIMEOUT alone reports', () => {
    const result = evaluate([
      page({ sequence: 1, path: '/', links: [{ href: '/slow' }] }),
      page({ sequence: 2, path: '/slow', viewports: { desktop: TIMEOUT_VIEWPORT, mobile: TIMEOUT_VIEWPORT } }),
    ]);

    expect(findingsOf(result, 'TARGET_NAVIGATION_FAILED')).toEqual([]);
    const timeouts = findingsOf(result, 'NAVIGATION_TIMEOUT');
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toMatchObject({ pageId: createPageId(2), pageUrl: pageUrlOf('/slow') });
  });

  it('reports TARGET_NAVIGATION_FAILED only for the viewports whose navigation outcome is FAILED', () => {
    const result = evaluate([
      page({ sequence: 1, path: '/', links: [{ href: '/mixed' }] }),
      page({ sequence: 2, path: '/mixed', viewports: { desktop: TIMEOUT_VIEWPORT, mobile: NAVIGATION_FAILED_VIEWPORT } }),
    ]);

    const findings = findingsOf(result, 'TARGET_NAVIGATION_FAILED');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('mobile');
    expect(findings[0]?.message).not.toContain('desktop');
  });

  it('does not report TARGET_NAVIGATION_FAILED for a skipped link target (navigation outcome null)', () => {
    const failed = page({
      sequence: 2,
      path: '/skipped',
      viewports: { desktop: NAVIGATION_FAILED_VIEWPORT, mobile: NAVIGATION_FAILED_VIEWPORT },
    });
    // ナビゲーションの失敗の理由が残っていても、ナビゲーションの結果が null（スキップ）なら Finding にしない。
    const skipped: CrossPagePageResult = {
      ...failed,
      viewports: {
        desktop: { ...failed.viewports.desktop, navigationOutcome: null },
        mobile: { ...failed.viewports.mobile, navigationOutcome: null },
      },
    };
    const result = evaluate([page({ sequence: 1, path: '/', links: [{ href: '/skipped' }] }), skipped]);

    expect(findingsOf(result, 'TARGET_NAVIGATION_FAILED')).toEqual([]);
  });

  it('distinguishes the 4xx and 5xx boundaries of BROKEN_INTERNAL_LINK (399, 400, 599, 600)', () => {
    const statuses = [399, 400, 599, 600] as const;
    const result = evaluate([
      page({ sequence: 1, path: '/', links: statuses.map((status) => ({ href: `/status-${status}` })) }),
      ...statuses.map((status, index) =>
        page({
          sequence: index + 2,
          path: `/status-${status}`,
          viewports: { desktop: { httpStatus: status }, mobile: { httpStatus: status } },
        })),
    ]);

    const messages = findingsOf(result, 'BROKEN_INTERNAL_LINK').map((finding) => finding.message);
    expect(messages).toHaveLength(2);
    expect(messages.some((message) => message.includes(pageUrlOf('/status-400')))).toBe(true);
    expect(messages.some((message) => message.includes(pageUrlOf('/status-599')))).toBe(true);
  });

  // P14a（RT12b の発見事項2）: リンク先を検証したかは、ナビゲーションの結果（`navigationOutcome`）が null でないビューポートが
  // あるかで決める。理由のコード `NAVIGATION_FAILED` では判断しない。
  it('treats a link target as verified when any viewport has a navigation outcome, regardless of the reason codes', () => {
    const timedOut = page({ sequence: 2, path: '/slow', viewports: { desktop: TIMEOUT_VIEWPORT, mobile: SKIPPED_VIEWPORT } });
    // 理由のコードがなくても、ナビゲーションの結果があれば、リンク先を検証したとする。
    const withoutReasonCode: CrossPagePageResult = {
      ...timedOut,
      viewports: { ...timedOut.viewports, desktop: { ...timedOut.viewports.desktop, incompleteReasons: [] } },
    };
    const result = evaluate([page({ sequence: 1, path: '/', links: [{ href: '/slow' }] }), withoutReasonCode]);

    expect(result.unverifiedInternalLinkCount).toBe(0);
  });

  it('treats a link target as not verified when every viewport has a null navigation outcome, regardless of the reason codes', () => {
    const failed = page({
      sequence: 2,
      path: '/skipped',
      viewports: { desktop: NAVIGATION_FAILED_VIEWPORT, mobile: NAVIGATION_FAILED_VIEWPORT },
    });
    // `NAVIGATION_FAILED` の理由が残っていても、ナビゲーションの結果が null（スキップ）なら、検証していない。
    const skipped: CrossPagePageResult = {
      ...failed,
      viewports: {
        desktop: { ...failed.viewports.desktop, navigationOutcome: null },
        mobile: { ...failed.viewports.mobile, navigationOutcome: null },
      },
    };
    const result = evaluate([page({ sequence: 1, path: '/', links: [{ href: '/skipped' }] }), skipped]);

    expect(result.unverifiedInternalLinkCount).toBe(1);
    expect(findingsOf(result, 'TARGET_NAVIGATION_FAILED')).toEqual([]);
    expect(findingsOf(result, 'BROKEN_INTERNAL_LINK')).toEqual([]);
  });

  it('counts link targets that were not audited instead of reporting them', () => {
    const result = evaluate([
      page({
        sequence: 1,
        path: '/',
        links: [{ href: '/not-crawled' }, { href: '/not-crawled#section' }, { href: '/skipped' }, { href: '/ok' }],
      }),
      page({ sequence: 2, path: '/ok', links: [{ href: '/not-crawled' }] }),
      page({ sequence: 3, path: '/skipped', viewports: { desktop: SKIPPED_VIEWPORT, mobile: SKIPPED_VIEWPORT } }),
    ]);

    expect(findingsOf(result, 'BROKEN_INTERNAL_LINK')).toEqual([]);
    expect(findingsOf(result, 'TARGET_NAVIGATION_FAILED')).toEqual([]);
    // リンク元のページとリンク先のURLの組ごとに数える: (/, /not-crawled)、(/, /skipped)、(/ok, /not-crawled)。
    expect(result.unverifiedInternalLinkCount).toBe(3);
  });
});

describe('evaluateCrossPageRules: titles', () => {
  it('reports DUPLICATE_PAGE_TITLE for each page whose normalized title equals a page with another canonical', () => {
    const result = evaluate([
      page({ sequence: 1, path: '/a', title: '会社概要' }),
      page({ sequence: 2, path: '/b', title: '  会社概要\n' }),
      page({ sequence: 3, path: '/c', title: '採用情報' }),
    ]);

    const findings = findingsOf(result, 'DUPLICATE_PAGE_TITLE');
    expect(findings.map((finding) => finding.pageId).sort()).toEqual([createPageId(1), createPageId(2)]);
    const first = findings.find((finding) => finding.pageId === createPageId(1));
    expect(first).toMatchObject({ category: 'CROSS_PAGE', severity: 'WARN', viewport: null, pageUrl: pageUrlOf('/a') });
    expect(first?.message).toContain('会社概要');
    expect(first?.message).toContain(pageUrlOf('/b'));
    expect(first?.evidenceRefs).toEqual(
      expect.arrayContaining([
        domEvidenceId({ sequence: 1, path: '/a' }, 'desktop'),
        domEvidenceId({ sequence: 1, path: '/a' }, 'mobile'),
      ]),
    );
  });

  it('does not report DUPLICATE_PAGE_TITLE for pages sharing a canonical, error pages, truncated or distinct titles', () => {
    const result = evaluate([
      page({ sequence: 1, path: '/list', title: '一覧', canonical: '/list' }),
      page({ sequence: 2, path: '/list?page=2', title: '一覧', canonical: '/list' }),
      page({ sequence: 3, path: '/gone-1', title: 'Not Found', viewports: { desktop: { httpStatus: 404 }, mobile: { httpStatus: 404 } } }),
      page({ sequence: 4, path: '/gone-2', title: 'Not Found', viewports: { desktop: { httpStatus: 404 }, mobile: { httpStatus: 404 } } }),
      page({ sequence: 5, path: '/long-1', title: '長いタイトル', titleTruncated: true }),
      page({ sequence: 6, path: '/long-2', title: '長いタイトル', titleTruncated: true }),
      page({ sequence: 7, path: '/reasons-6', title: '6つの理由' }),
      page({ sequence: 8, path: '/reasons-7', title: '7つの理由' }),
    ]);

    expect(findingsOf(result, 'DUPLICATE_PAGE_TITLE')).toEqual([]);
  });
});

describe('evaluateCrossPageRules: canonical', () => {
  it('reports DUPLICATE_CANONICAL when different pages declare a canonical that none of them is', () => {
    const result = evaluate([
      page({ sequence: 1, path: '/b', canonical: '/x' }),
      page({ sequence: 2, path: '/c', canonical: `${ORIGIN}/x` }),
      page({ sequence: 3, path: '/x', canonical: '/other' }),
      page({ sequence: 4, path: '/other' }),
    ]);

    const findings = findingsOf(result, 'DUPLICATE_CANONICAL');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ category: 'CROSS_PAGE', severity: 'WARN', viewport: null });
    expect(findings[0]?.message).toContain(pageUrlOf('/x'));
    expect(findings[0]?.message).toContain(pageUrlOf('/b'));
    expect(findings[0]?.message).toContain(pageUrlOf('/c'));
    expect(findings[0]?.evidenceRefs).toEqual(
      expect.arrayContaining([
        domEvidenceId({ sequence: 1, path: '/b' }, 'desktop'),
        domEvidenceId({ sequence: 2, path: '/c' }, 'desktop'),
      ]),
    );
    expect(findingsOf(result, 'MULTIPLE_URLS_SAME_CANONICAL')).toEqual([]);
  });

  it('reports MULTIPLE_URLS_SAME_CANONICAL instead when the canonical page itself is among the declaring pages', () => {
    const result = evaluate([
      page({ sequence: 1, path: '/list', canonical: '/list' }),
      page({ sequence: 2, path: '/list?page=2', canonical: '/list' }),
    ]);

    expect(findingsOf(result, 'DUPLICATE_CANONICAL')).toEqual([]);
    const findings = findingsOf(result, 'MULTIPLE_URLS_SAME_CANONICAL');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ category: 'CROSS_PAGE', severity: 'INFO', viewport: null });
    expect(findings[0]?.message).toContain(`${ORIGIN}/list?page=2`);
  });

  it('does not report DUPLICATE_CANONICAL when /p and /p?ref=a both redirect to /p/, which declares itself as canonical', () => {
    const redirectedToSlash: Partial<Record<ViewportProfile, ViewportSpec>> = {
      desktop: { httpStatus: 200, finalUrl: `${ORIGIN}/p/` },
      mobile: { httpStatus: 200, finalUrl: `${ORIGIN}/p/` },
    };
    const result = evaluate([
      page({ sequence: 1, path: '/p', canonical: '/p/', viewports: redirectedToSlash }),
      page({ sequence: 2, path: '/p?ref=a', canonical: '/p/', viewports: redirectedToSlash }),
    ]);

    expect(pageUrlOf('/p?ref=a')).toBe(`${ORIGIN}/p?ref=a`);
    expect(findingsOf(result, 'DUPLICATE_CANONICAL')).toEqual([]);
    // 最終URLが canonical 自身なので、複数のURLが同じ canonical を指す事実の記録（INFO）になる。
    const multiple = findingsOf(result, 'MULTIPLE_URLS_SAME_CANONICAL');
    expect(multiple).toHaveLength(1);
    expect(multiple[0]?.message).toContain(`${ORIGIN}/p/`);
  });

  it('treats a canonical as the page itself when the final URL of any viewport equals it', () => {
    const result = evaluate([
      page({
        sequence: 1,
        path: '/q',
        canonical: '/q/',
        viewports: { desktop: { httpStatus: 200 }, mobile: { httpStatus: 200, finalUrl: `${ORIGIN}/q/` } },
      }),
      page({ sequence: 2, path: '/q-copy', canonical: '/q/' }),
    ]);

    expect(findingsOf(result, 'DUPLICATE_CANONICAL')).toEqual([]);
    expect(findingsOf(result, 'MULTIPLE_URLS_SAME_CANONICAL')).toHaveLength(1);
  });

  it('does not report canonical duplication when each page declares its own canonical', () => {
    const result = evaluate([
      page({ sequence: 1, path: '/a', canonical: '/a' }),
      page({ sequence: 2, path: '/b', canonical: '/b' }),
      page({ sequence: 3, path: '/c' }),
    ]);

    expect(findingsOf(result, 'DUPLICATE_CANONICAL')).toEqual([]);
    expect(findingsOf(result, 'MULTIPLE_URLS_SAME_CANONICAL')).toEqual([]);
  });

  it('reports CANONICAL_TARGET_NOT_FOUND when the canonical target was not discovered or answered 4xx/5xx', () => {
    const result = evaluate([
      page({ sequence: 1, path: '/a', canonical: '/never-linked' }),
      page({ sequence: 2, path: '/b', canonical: '/gone' }),
      page({ sequence: 3, path: '/gone', viewports: { desktop: { httpStatus: 410 }, mobile: { httpStatus: 410 } } }),
    ]);

    const findings = findingsOf(result, 'CANONICAL_TARGET_NOT_FOUND');
    expect(findings.map((finding) => finding.pageId).sort()).toEqual([createPageId(1), createPageId(2)]);
    const notDiscovered = findings.find((finding) => finding.pageId === createPageId(1));
    expect(notDiscovered).toMatchObject({ category: 'CROSS_PAGE', severity: 'WARN', viewport: null });
    expect(notDiscovered?.message).toContain(pageUrlOf('/never-linked'));
    const gone = findings.find((finding) => finding.pageId === createPageId(2));
    expect(gone?.message).toContain('410');
  });

  it('does not report CANONICAL_TARGET_NOT_FOUND for found, redirected-to, unaudited but discovered, or external targets', () => {
    const result = evaluate([
      page({ sequence: 1, path: '/a', canonical: '/b' }),
      page({ sequence: 2, path: '/b' }),
      page({ sequence: 3, path: '/c', canonical: '/d/', links: [{ href: '/linked-only' }] }),
      page({ sequence: 4, path: '/d', viewports: { desktop: { httpStatus: 200, finalUrl: `${ORIGIN}/d/` }, mobile: { httpStatus: 200, finalUrl: `${ORIGIN}/d/` } } }),
      page({ sequence: 5, path: '/e', canonical: '/linked-only' }),
      page({ sequence: 6, path: '/f', canonical: `${OTHER_ORIGIN}/f` }),
    ]);

    expect(findingsOf(result, 'CANONICAL_TARGET_NOT_FOUND')).toEqual([]);
  });

  it('reports INCONSISTENT_ORIGIN for a canonical outside the allowed origins', () => {
    const declaring = { sequence: 1, path: '/a' } as const;
    const result = evaluate([page({ ...declaring, canonical: `${OTHER_ORIGIN}/a` })]);

    const findings = findingsOf(result, 'INCONSISTENT_ORIGIN');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      category: 'CROSS_PAGE',
      severity: 'WARN',
      pageId: createPageId(1),
      viewport: null,
      evidenceRefs: [domEvidenceId(declaring, 'desktop'), domEvidenceId(declaring, 'mobile')].sort(),
    });
    expect(findings[0]?.message).toContain(`${OTHER_ORIGIN}/a`);
  });

  it('leaves a final URL outside the allowed origins to UNEXPECTED_ORIGIN_REDIRECT and does not report INCONSISTENT_ORIGIN for it', () => {
    const escaped = { sequence: 2, path: '/b' } as const;
    const result = evaluate([
      page({
        ...escaped,
        viewports: { desktop: { httpStatus: 200 }, mobile: { httpStatus: 200, finalUrl: `${OTHER_ORIGIN}/m/b` } },
      }),
    ]);

    expect(findingsOf(result, 'INCONSISTENT_ORIGIN')).toEqual([]);
    const redirects = findingsOf(result, 'UNEXPECTED_ORIGIN_REDIRECT');
    expect(redirects).toHaveLength(1);
    expect(redirects[0]?.message).toContain(`${OTHER_ORIGIN}/m/b`);
    expect(redirects[0]?.evidenceRefs).toEqual([networkEvidenceId(escaped, 'mobile')]);
  });

  it('does not report INCONSISTENT_ORIGIN for canonicals and final URLs inside the allowed origins', () => {
    const result = evaluate([
      page({ sequence: 1, path: '/a', canonical: '/a' }),
      page({ sequence: 2, path: '/b', viewports: { desktop: { httpStatus: 200, finalUrl: `${ORIGIN}/b/` } } }),
    ]);

    expect(findingsOf(result, 'INCONSISTENT_ORIGIN')).toEqual([]);
  });
});

describe('evaluateCrossPageRules: navigation outcomes', () => {
  it('reports NAVIGATION_TIMEOUT once per page whose navigation timed out, without splitting by viewport', () => {
    const both = { sequence: 1, path: '/slow' } as const;
    const mobileOnly = { sequence: 2, path: '/slow-mobile' } as const;
    const result = evaluate([
      page({ ...both, viewports: { desktop: TIMEOUT_VIEWPORT, mobile: TIMEOUT_VIEWPORT } }),
      page({ ...mobileOnly, viewports: { mobile: TIMEOUT_VIEWPORT } }),
      page({ sequence: 3, path: '/fast' }),
    ]);

    const findings = findingsOf(result, 'NAVIGATION_TIMEOUT');
    expect(findings).toHaveLength(2);
    const slow = findings.find((finding) => finding.pageId === createPageId(1));
    expect(slow).toMatchObject({
      category: 'HTTP',
      severity: 'ERROR',
      pageUrl: pageUrlOf('/slow'),
      viewport: null,
      evidenceRefs: [networkEvidenceId(both, 'desktop'), networkEvidenceId(both, 'mobile')].sort(),
    });
    expect(slow?.message).toContain(pageUrlOf('/slow'));
    expect(slow?.message).toContain('desktop');
    expect(slow?.message).toContain('mobile');
    const slowMobile = findings.find((finding) => finding.pageId === createPageId(2));
    expect(slowMobile).toMatchObject({ viewport: null, evidenceRefs: [networkEvidenceId(mobileOnly, 'mobile')] });
    expect(slowMobile?.message).toContain('mobile');
    expect(slowMobile?.message).not.toContain('desktop');
  });

  it('does not report NAVIGATION_TIMEOUT for OK, failed, blocked, or skipped navigations', () => {
    const result = evaluate([
      page({ sequence: 1, path: '/ok' }),
      page({ sequence: 2, path: '/failed', viewports: { desktop: NAVIGATION_FAILED_VIEWPORT, mobile: NAVIGATION_FAILED_VIEWPORT } }),
      page({ sequence: 3, path: '/blocked', viewports: { desktop: BLOCKED_REDIRECT_VIEWPORT } }),
      page({ sequence: 4, path: '/skipped', viewports: { desktop: SKIPPED_VIEWPORT, mobile: SKIPPED_VIEWPORT } }),
    ]);

    expect(findingsOf(result, 'NAVIGATION_TIMEOUT')).toEqual([]);
  });

  it('reports UNEXPECTED_ORIGIN_REDIRECT once per page for a blocked external redirect or a final URL outside the allowed origins', () => {
    const blocked = { sequence: 1, path: '/to-partner' } as const;
    const escaped = { sequence: 2, path: '/escaped' } as const;
    const result = evaluate([
      page({ ...blocked, viewports: { desktop: BLOCKED_REDIRECT_VIEWPORT, mobile: BLOCKED_REDIRECT_VIEWPORT } }),
      page({
        ...escaped,
        viewports: { desktop: { httpStatus: 200 }, mobile: { httpStatus: 200, finalUrl: `${OTHER_ORIGIN}/m/escaped` } },
      }),
    ]);

    const findings = findingsOf(result, 'UNEXPECTED_ORIGIN_REDIRECT');
    expect(findings).toHaveLength(2);
    const blockedFinding = findings.find((finding) => finding.pageId === createPageId(1));
    expect(blockedFinding).toMatchObject({
      category: 'HTTP',
      severity: 'WARN',
      pageUrl: pageUrlOf('/to-partner'),
      viewport: null,
      evidenceRefs: [networkEvidenceId(blocked, 'desktop'), networkEvidenceId(blocked, 'mobile')].sort(),
    });
    expect(blockedFinding?.message).toContain(pageUrlOf('/to-partner'));
    const escapedFinding = findings.find((finding) => finding.pageId === createPageId(2));
    expect(escapedFinding).toMatchObject({
      category: 'HTTP',
      severity: 'WARN',
      viewport: null,
      evidenceRefs: [networkEvidenceId(escaped, 'mobile')],
    });
    expect(escapedFinding?.message).toContain(`${OTHER_ORIGIN}/m/escaped`);
    expect(escapedFinding?.message).toContain('mobile');
    expect(escapedFinding?.message).not.toContain('desktop');
  });

  it('does not report UNEXPECTED_ORIGIN_REDIRECT for OK navigations, redirects inside the allowed origins such as http to https, or timeouts', () => {
    const result = evaluate(
      [
        page({ sequence: 1, path: '/ok' }),
        page({
          sequence: 2,
          path: '/secure',
          viewports: {
            desktop: { httpStatus: 200, finalUrl: `${HTTPS_ORIGIN}/secure` },
            mobile: { httpStatus: 200, finalUrl: `${HTTPS_ORIGIN}/secure` },
          },
        }),
        page({ sequence: 3, path: '/moved', viewports: { desktop: { httpStatus: 200, finalUrl: `${ORIGIN}/moved/` } } }),
        page({ sequence: 4, path: '/slow', viewports: { desktop: TIMEOUT_VIEWPORT } }),
        page({ sequence: 5, path: '/failed', viewports: { desktop: NAVIGATION_FAILED_VIEWPORT } }),
      ],
      { allowedOrigins: [ORIGIN, HTTPS_ORIGIN] },
    );

    expect(findingsOf(result, 'UNEXPECTED_ORIGIN_REDIRECT')).toEqual([]);
  });

  it('does not report a navigation finding for a viewport without network evidence to reference', () => {
    const result = evaluate([
      { ...page({ sequence: 1, path: '/slow', viewports: { desktop: TIMEOUT_VIEWPORT } }), evidence: [] },
      { ...page({ sequence: 2, path: '/to-partner', viewports: { desktop: BLOCKED_REDIRECT_VIEWPORT } }), evidence: [] },
    ]);

    expect(findingsOf(result, 'NAVIGATION_TIMEOUT')).toEqual([]);
    expect(findingsOf(result, 'UNEXPECTED_ORIGIN_REDIRECT')).toEqual([]);
    expect(result.failures).toEqual([]);
  });
});

describe('evaluateCrossPageRules: sitemap', () => {
  it('reports SITEMAP_URL_NOT_DISCOVERED as INFO for sitemap URLs that the crawl did not discover', () => {
    const result = evaluate(
      [page({ sequence: 1, path: '/', links: [{ href: '/linked' }] })],
      { sitemap: sitemap(['/', '/linked', '/orphan']) },
    );

    const findings = findingsOf(result, 'SITEMAP_URL_NOT_DISCOVERED');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      category: 'CROSS_PAGE',
      severity: 'INFO',
      viewport: null,
      pageId: null,
      pageUrl: null,
      evidenceRefs: [SITEMAP_EVIDENCE_ID],
    });
    expect(findings[0]?.message).toContain(pageUrlOf('/orphan'));
  });

  it('reports DISCOVERED_URL_NOT_IN_SITEMAP as INFO for discovered URLs missing from the sitemap', () => {
    const result = evaluate(
      [page({ sequence: 1, path: '/', links: [{ href: '/linked' }] }), page({ sequence: 2, path: '/audited' })],
      { sitemap: sitemap(['/']) },
    );

    const findings = findingsOf(result, 'DISCOVERED_URL_NOT_IN_SITEMAP');
    expect(findings).toHaveLength(2);
    for (const finding of findings) {
      expect(finding).toMatchObject({ category: 'CROSS_PAGE', severity: 'INFO', viewport: null });
      expect(finding.evidenceRefs).toContain(SITEMAP_EVIDENCE_ID);
    }
    expect(findings.find((finding) => finding.message.includes(pageUrlOf('/linked')))).toBeDefined();
    expect(findings.find((finding) => finding.pageId === createPageId(2))?.message).toContain(pageUrlOf('/audited'));
  });

  it('reports no sitemap finding when the sitemap and the crawl agree or no sitemap was given', () => {
    const pages = [page({ sequence: 1, path: '/', links: [{ href: '/linked' }] })];

    const agreeing = evaluate(pages, { sitemap: sitemap(['/', '/linked', `${OTHER_ORIGIN}/elsewhere`]) });
    expect(findingsOf(agreeing, 'SITEMAP_URL_NOT_DISCOVERED')).toEqual([]);
    expect(findingsOf(agreeing, 'DISCOVERED_URL_NOT_IN_SITEMAP')).toEqual([]);

    for (const absent of [evaluate(pages), evaluate(pages, { sitemap: null })]) {
      expect(findingsOf(absent, 'SITEMAP_URL_NOT_DISCOVERED')).toEqual([]);
      expect(findingsOf(absent, 'DISCOVERED_URL_NOT_IN_SITEMAP')).toEqual([]);
    }
  });

  // R15a（Task 12・13 の設計書 第7章、Task 14〜17 の設計書 5.6.2）: 上限で切り詰めた sitemap では、sitemap にないとは言えない。
  it('does not report DISCOVERED_URL_NOT_IN_SITEMAP when the sitemap was truncated, but still reports sitemap URLs not discovered', () => {
    const pages = [page({ sequence: 1, path: '/', links: [{ href: '/linked' }] }), page({ sequence: 2, path: '/audited' })];

    const truncated = evaluate(pages, { sitemap: sitemap(['/', '/orphan'], true) });
    expect(findingsOf(truncated, 'DISCOVERED_URL_NOT_IN_SITEMAP')).toEqual([]);
    const notDiscovered = findingsOf(truncated, 'SITEMAP_URL_NOT_DISCOVERED');
    expect(notDiscovered).toHaveLength(1);
    expect(notDiscovered[0]?.message).toContain(pageUrlOf('/orphan'));

    // 同じ URL の一覧でも、切り詰めていなければ判定する。
    const complete = evaluate(pages, { sitemap: sitemap(['/', '/orphan'], false) });
    expect(findingsOf(complete, 'DISCOVERED_URL_NOT_IN_SITEMAP')).toHaveLength(2);
  });

  it('never reports an ERROR only because of a sitemap disagreement', () => {
    const result = evaluate(
      [page({ sequence: 1, path: '/', links: [{ href: '/linked' }] })],
      { sitemap: sitemap(['/orphan-1', '/orphan-2']) },
    );

    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings.filter((finding) => finding.severity === 'ERROR')).toEqual([]);
  });
});

// T18e（Task 18 の設計書 4.4 の ARCH04）: 許可Originの中かの判定を URL の owner に委ねても、境界の例で結果が変わらないこと。
// 置き換えの前の実装で PASS させてから、置き換えの後も PASS することを確かめる。
describe('evaluateCrossPageRules: allowed origin boundaries', () => {
  /** https の既定のポートを明示した許可Origin（`https://127.0.0.1` に正規化される）を加える。 */
  const BOUNDARY_ALLOWED_ORIGINS: readonly string[] = [ORIGIN, 'https://127.0.0.1:443'];

  interface BoundaryCase {
    readonly raw: string;
    /** 正規化した URL。正規化できない場合は `null`。 */
    readonly normalized: string | null;
    /** 許可Originの外なら、その Origin。中か、正規化できない場合は `null`。 */
    readonly outsideOrigin: string | null;
  }

  const BOUNDARY_CASES: readonly BoundaryCase[] = [
    // 許可Originの中
    { raw: `${ORIGIN}/inside`, normalized: `${ORIGIN}/inside`, outsideOrigin: null },
    { raw: 'HTTP://127.0.0.1:4173/upper-scheme', normalized: `${ORIGIN}/upper-scheme`, outsideOrigin: null },
    { raw: 'https://127.0.0.1/default-port', normalized: 'https://127.0.0.1/default-port', outsideOrigin: null },
    { raw: 'https://127.0.0.1:443/explicit-default-port', normalized: 'https://127.0.0.1/explicit-default-port', outsideOrigin: null },
    // 許可Originの外（ホスト、http と https の違い、ポートの違い）
    { raw: 'http://127.0.0.2:4173/other-host', normalized: 'http://127.0.0.2:4173/other-host', outsideOrigin: 'http://127.0.0.2:4173' },
    { raw: `${HTTPS_ORIGIN}/https`, normalized: `${HTTPS_ORIGIN}/https`, outsideOrigin: HTTPS_ORIGIN },
    { raw: 'http://127.0.0.1/http-default-port', normalized: 'http://127.0.0.1/http-default-port', outsideOrigin: 'http://127.0.0.1' },
    { raw: `${OTHER_ORIGIN}/port`, normalized: `${OTHER_ORIGIN}/port`, outsideOrigin: OTHER_ORIGIN },
    // 正規化できない URL（解析できない、http・https 以外、認証情報を含む）
    { raw: 'http://[::1/invalid', normalized: null, outsideOrigin: null },
    { raw: 'ftp://127.0.0.1:4173/ftp', normalized: null, outsideOrigin: null },
    { raw: 'http://user:secret@127.0.0.1:4173/credentials', normalized: null, outsideOrigin: null },
  ];

  const insideCases = BOUNDARY_CASES.filter((item) => item.normalized !== null && item.outsideOrigin === null);
  const outsideCases = BOUNDARY_CASES.filter((item) => item.outsideOrigin !== null);
  const sequenceOf = (item: BoundaryCase): number => BOUNDARY_CASES.indexOf(item) + 1;
  const pageIdsOf = (items: readonly BoundaryCase[]): string[] => items.map((item) => createPageId(sequenceOf(item))).sort();

  it('checks that the boundary cases are normalized as expected', () => {
    for (const item of BOUNDARY_CASES) {
      const normalized = normalizeUrl(item.raw, `${ORIGIN}/`, new Set(ALLOWED_QUERY_PARAMETERS));
      expect(normalized.ok ? normalized.url : null, item.raw).toBe(item.normalized);
    }
  });

  it('reports INCONSISTENT_ORIGIN only for canonicals outside the allowed origins, with their origins', () => {
    const result = evaluate(
      BOUNDARY_CASES.map((item) => page({ sequence: sequenceOf(item), path: `/page-${sequenceOf(item)}`, canonical: item.raw })),
      { allowedOrigins: BOUNDARY_ALLOWED_ORIGINS },
    );

    const findings = findingsOf(result, 'INCONSISTENT_ORIGIN');
    expect(findings.map((finding) => finding.pageId).sort()).toEqual(pageIdsOf(outsideCases));
    for (const item of outsideCases) {
      const finding = findings.find((candidate) => candidate.pageId === createPageId(sequenceOf(item)));
      expect(finding?.message).toContain(`canonical ${item.normalized ?? ''} の Origin ${item.outsideOrigin ?? ''} は`);
    }
  });

  it('reports CANONICAL_TARGET_NOT_FOUND only for undiscovered canonicals inside the allowed origins', () => {
    const result = evaluate(
      BOUNDARY_CASES.map((item) => page({ sequence: sequenceOf(item), path: `/page-${sequenceOf(item)}`, canonical: item.raw })),
      { allowedOrigins: BOUNDARY_ALLOWED_ORIGINS },
    );

    const findings = findingsOf(result, 'CANONICAL_TARGET_NOT_FOUND');
    expect(findings.map((finding) => finding.pageId).sort()).toEqual(pageIdsOf(insideCases));
    for (const item of insideCases) {
      const finding = findings.find((candidate) => candidate.pageId === createPageId(sequenceOf(item)));
      expect(finding?.message).toContain(`canonical の遷移先 ${item.normalized ?? ''} は、クロールで発見されませんでした。`);
    }
  });

  it('reports UNEXPECTED_ORIGIN_REDIRECT only for final URLs outside the allowed origins', () => {
    const result = evaluate(
      BOUNDARY_CASES.map((item) => page({
        sequence: sequenceOf(item),
        path: `/page-${sequenceOf(item)}`,
        viewports: { desktop: { httpStatus: 200, finalUrl: item.raw }, mobile: { httpStatus: 200, finalUrl: item.raw } },
      })),
      { allowedOrigins: BOUNDARY_ALLOWED_ORIGINS },
    );

    const findings = findingsOf(result, 'UNEXPECTED_ORIGIN_REDIRECT');
    expect(findings.map((finding) => finding.pageId).sort()).toEqual(pageIdsOf(outsideCases));
    for (const item of outsideCases) {
      const finding = findings.find((candidate) => candidate.pageId === createPageId(sequenceOf(item)));
      expect(finding?.message).toContain(`desktop: 最終URL ${item.normalized ?? ''}`);
      expect(finding?.message).toContain(`mobile: 最終URL ${item.normalized ?? ''}`);
    }
  });

  it('keeps only sitemap URLs inside the allowed origins', () => {
    const result = evaluate([page({ sequence: 100, path: '/' })], {
      allowedOrigins: BOUNDARY_ALLOWED_ORIGINS,
      sitemap: { evidenceId: SITEMAP_EVIDENCE_ID, urls: BOUNDARY_CASES.map((item) => item.raw), truncated: false },
    });

    const findings = findingsOf(result, 'SITEMAP_URL_NOT_DISCOVERED');
    expect(findings.map((finding) => finding.message).sort()).toEqual(
      insideCases.map((item) => `sitemap にあるURL ${item.normalized ?? ''} は、クロールで発見されませんでした。`).sort(),
    );
  });
});

describe('evaluateCrossPageRules: determinism and contract', () => {
  const scenarioPages = (): CrossPagePageResult[] => [
    page({ sequence: 1, path: '/', title: '共通', links: [{ href: '/missing' }, { href: '/unreachable' }, { href: '/not-crawled' }] }),
    page({ sequence: 2, path: '/missing', title: '共通', viewports: { desktop: { httpStatus: 404 }, mobile: { httpStatus: 404 } } }),
    page({ sequence: 3, path: '/unreachable', viewports: { desktop: NAVIGATION_FAILED_VIEWPORT, mobile: NAVIGATION_FAILED_VIEWPORT } }),
    page({ sequence: 4, path: '/b', title: '共通', canonical: '/x', links: [{ href: '/missing' }] }),
    page({ sequence: 5, path: '/c', title: '共通', canonical: '/x' }),
    page({ sequence: 6, path: '/d', canonical: `${OTHER_ORIGIN}/d` }),
    page({ sequence: 7, path: '/slow', viewports: { desktop: TIMEOUT_VIEWPORT, mobile: TIMEOUT_VIEWPORT } }),
    page({ sequence: 8, path: '/to-partner', viewports: { mobile: BLOCKED_REDIRECT_VIEWPORT } }),
    page({ sequence: 9, path: '/escaped', viewports: { desktop: { httpStatus: 200, finalUrl: `${OTHER_ORIGIN}/escaped` } } }),
  ];

  const reversed = (pages: readonly CrossPagePageResult[]): CrossPagePageResult[] =>
    [...pages].reverse().map((item) => ({
      ...item,
      evidence: [...item.evidence].reverse().map((record): EvidenceRecord =>
        record.type === 'link'
          ? { ...record, payload: { ...record.payload, links: [...record.payload.links].reverse() } }
          : record),
    }));

  it('does not depend on the order of pages, evidence, links, or sitemap URLs', () => {
    const forward = evaluate(scenarioPages(), { sitemap: sitemap(['/', '/orphan', '/other-orphan']) });
    const backward = evaluate(reversed(scenarioPages()), {
      sitemap: sitemap(['/other-orphan', '/orphan', '/']),
      allowedOrigins: [ORIGIN],
    });

    expect(forward.findings.length).toBeGreaterThan(5);
    expect(findingsOf(forward, 'NAVIGATION_TIMEOUT')).toHaveLength(1);
    expect(findingsOf(forward, 'UNEXPECTED_ORIGIN_REDIRECT')).toHaveLength(2);
    // 許可Originの外の canonical（/d）だけ。最終URLが外の /escaped は、UNEXPECTED_ORIGIN_REDIRECT だけが扱う。
    expect(findingsOf(forward, 'INCONSISTENT_ORIGIN')).toHaveLength(1);
    expect(backward).toEqual(forward);
  });

  it('numbers findings from the injected sequence and fingerprints them with the injected target id', () => {
    const result = evaluate(scenarioPages(), { firstFindingSequence: 40 });

    expect(result.failures).toEqual([]);
    expect(result.findings.map((finding) => finding.findingId)).toEqual(
      result.findings.map((_finding, index) => createFindingId(40 + index)),
    );
    expect(result.nextFindingSequence).toBe(40 + result.findings.length);

    const other = evaluate(scenarioPages(), { targetId: 'another-fixture-target' });
    expect(other.findings.map((finding) => finding.fingerprint)).not.toEqual(
      result.findings.map((finding) => finding.fingerprint),
    );
  });

  it('fingerprints a viewport-independent finding without the viewport', () => {
    const result = evaluate([
      page({ sequence: 1, path: '/', links: [{ href: '/missing' }] }),
      page({ sequence: 2, path: '/missing', viewports: { desktop: { httpStatus: 404 }, mobile: { httpStatus: 404 } } }),
    ]);

    const [finding] = findingsOf(result, 'BROKEN_INTERNAL_LINK');
    const rule = CROSS_PAGE_RULES.find((candidate) => candidate.ruleId === 'BROKEN_INTERNAL_LINK');
    expect(finding?.viewport).toBeNull();
    expect(finding?.fingerprint).toBe(
      createFindingFingerprint({
        targetId: TARGET_ID,
        ruleId: 'BROKEN_INTERNAL_LINK',
        ruleVersion: rule?.version ?? 0,
        normalizedUrl: pageUrlOf('/'),
        identityFields: [{ name: 'targetUrl', value: pageUrlOf('/missing') }],
      }),
    );
  });

  it('does not report semantic duplication of headings or link text such as 6つの理由 and 7つの理由', () => {
    const result = evaluate([
      page({
        sequence: 1,
        path: '/',
        title: 'トップ',
        headings: ['6つの理由'],
        links: [{ href: '/reasons', text: '6つの理由' }, { href: '/symptoms', text: '交通事故' }],
      }),
      page({ sequence: 2, path: '/reasons', title: '選ばれる理由', headings: ['7つの理由'], links: [{ href: '/', text: '7つの理由' }] }),
      page({ sequence: 3, path: '/symptoms', title: '症状', headings: ['6つの理由'] }),
    ]);

    expect(result.findings).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  it('returns no findings and does not throw for an input without pages or evidence', () => {
    const empty = evaluate([]);
    expect(empty).toEqual({ findings: [], failures: [], nextFindingSequence: 0, unverifiedInternalLinkCount: 0 });

    const withoutEvidence = evaluate([{ ...page({ sequence: 1, path: '/' }), evidence: [] }]);
    expect(withoutEvidence.findings).toEqual([]);
    expect(withoutEvidence.failures).toEqual([]);
  });

  it('contains an exception of one rule as a RULE_EVALUATION_FAILED failure and keeps the findings of the other rules', () => {
    const throwingRule: CrossPageRule = {
      ruleId: 'FIXTURE_THROWING_CROSS_PAGE_RULE',
      version: 1,
      category: 'CROSS_PAGE',
      severity: 'WARN',
      evaluate: () => {
        throw new Error('fixture cross-page rule failure');
      },
    };
    const brokenLink = CROSS_PAGE_RULES.find((rule) => rule.ruleId === 'BROKEN_INTERNAL_LINK');
    if (brokenLink === undefined) {
      throw new Error('BROKEN_INTERNAL_LINK must be registered');
    }
    const input: CrossPageRuleInput = {
      targetId: TARGET_ID,
      firstFindingSequence: 0,
      allowedOrigins: [ORIGIN],
      allowedQueryParameters: ALLOWED_QUERY_PARAMETERS,
      pages: [
        page({ sequence: 1, path: '/', links: [{ href: '/missing' }] }),
        page({ sequence: 2, path: '/missing', viewports: { desktop: { httpStatus: 404 }, mobile: { httpStatus: 404 } } }),
      ],
    };

    const result = evaluateCrossPageRules(input, [throwingRule, brokenLink]);

    expect(result.findings.map((finding) => finding.ruleId)).toEqual(['BROKEN_INTERNAL_LINK']);
    expect(result.failures).toEqual([
      { code: 'RULE_EVALUATION_FAILED', ruleId: 'FIXTURE_THROWING_CROSS_PAGE_RULE', message: 'fixture cross-page rule failure' },
    ]);
    expect(result.nextFindingSequence).toBe(1);
  });

  describe('rule list checks shared with freezeCatalog', () => {
    const fakeRule = (ruleId: string): CrossPageRule => ({
      ruleId,
      version: 1,
      category: 'CROSS_PAGE',
      severity: 'INFO',
      evaluate: () => [],
    });
    const input: CrossPageRuleInput = {
      targetId: TARGET_ID,
      firstFindingSequence: 0,
      allowedOrigins: [ORIGIN],
      allowedQueryParameters: ALLOWED_QUERY_PARAMETERS,
      pages: [page({ sequence: 1, path: '/' })],
    };

    it('rejects a rule list that registers the same rule id twice', () => {
      expect(() => evaluateCrossPageRules(input, [fakeRule('FIXTURE_TWICE'), fakeRule('FIXTURE_TWICE')])).toThrow(
        /FIXTURE_TWICE/u,
      );
    });

    it('rejects a rule whose rule id is also a page rule id', () => {
      const pageRuleId = RULE_CATALOG[0]?.ruleId ?? 'HTTP_4XX';
      expect(() => evaluateCrossPageRules(input, [fakeRule(pageRuleId)])).toThrow(new RegExp(pageRuleId, 'u'));
    });

    it('rejects a rule whose rule id starts with the rule id prefix of a page rule', () => {
      const prefix = RULE_CATALOG.find((rule) => rule.ruleIdPrefix !== undefined)?.ruleIdPrefix;
      expect(prefix).toBeDefined();
      const collidingRuleId = `${prefix ?? ''}FIXTURE_CROSS_PAGE`;
      expect(() => evaluateCrossPageRules(input, [fakeRule(collidingRuleId)])).toThrow(new RegExp(collidingRuleId, 'u'));
    });

    it('rejects a rule whose version is not a positive integer', () => {
      expect(() => evaluateCrossPageRules(input, [{ ...fakeRule('FIXTURE_BAD_VERSION'), version: 0 }])).toThrow(RangeError);
    });

    it('treats a draft whose rule version or category differs from its rule as a failure of that rule', () => {
      const pages = [
        page({ sequence: 1, path: '/', links: [{ href: '/missing' }] }),
        page({ sequence: 2, path: '/missing', viewports: { desktop: { httpStatus: 404 }, mobile: { httpStatus: 404 } } }),
      ];
      const brokenLink = CROSS_PAGE_RULES.find((rule) => rule.ruleId === 'BROKEN_INTERNAL_LINK');
      if (brokenLink === undefined) {
        throw new Error('BROKEN_INTERNAL_LINK must be registered');
      }
      const tampered = (ruleId: string, override: { readonly ruleVersion?: number }): CrossPageRule => ({
        ruleId,
        version: brokenLink.version,
        category: brokenLink.category,
        severity: brokenLink.severity,
        evaluate: (index) =>
          brokenLink.evaluate(index).map(({ context, draft }) => ({ context, draft: { ...draft, ruleId, ...override } })),
      });

      const result = evaluateCrossPageRules({ ...input, pages }, [
        tampered('FIXTURE_WRONG_VERSION', { ruleVersion: brokenLink.version + 1 }),
        { ...tampered('FIXTURE_WRONG_CATEGORY', {}), category: 'CROSS_PAGE' },
        brokenLink,
      ]);

      expect(result.findings.map((finding) => finding.ruleId)).toEqual(['BROKEN_INTERNAL_LINK']);
      expect(result.failures.map((failure) => [failure.code, failure.ruleId])).toEqual([
        ['RULE_EVALUATION_FAILED', 'FIXTURE_WRONG_CATEGORY'],
        ['RULE_EVALUATION_FAILED', 'FIXTURE_WRONG_VERSION'],
      ]);
    });
  });

  it('returns a frozen result', () => {
    const result = evaluate(scenarioPages());
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.findings)).toBe(true);
  });
});
