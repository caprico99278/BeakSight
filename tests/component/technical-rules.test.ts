import { describe, expect, it } from 'vitest';
import type { PageRuleInput } from '../../src/audit/rule.js';
import { RULE_CATALOG } from '../../src/audit/rule-catalog.js';
import { RuleEngine } from '../../src/audit/rule-engine.js';
import { TECHNICAL_RULES } from '../../src/audit/technical-rules.js';
import type {
  EvidenceRecord,
  EvidenceRecordFor,
  Finding,
  FindingCategory,
  Severity,
  ViewportProfile,
} from '../../src/core/contracts.js';
import type {
  ConsoleEvidence,
  DomEvidence,
  FormDomEvidence,
  FormFieldEvidence,
  ImageDomEvidence,
  LinkDiscoveryEvidence,
  LinkEvidence,
  NetworkEvidence,
  NetworkFailureEvidence,
  NetworkRequestEvidence,
  NetworkResponseEvidence,
  NetworkTimingEvidence,
  NormalizedHttpUrlEvidence,
  PageErrorEvidence,
} from '../../src/core/evidence-types.js';
import { createEvidenceId, createPageId } from '../../src/core/ids.js';

const TARGET_ID = 'technical-rules-fixture-target';
const PAGE_ID = createPageId(3);
const ORIGIN = 'http://127.0.0.1:4173';
const PAGE_URL = `${ORIGIN}/technical/page` as NormalizedHttpUrlEvidence;
const OBSERVED_AT = '2026-09-24T00:00:00.000Z';

// ---------------------------------------------------------------------------------------------------------------
// Evidence の組み立て
// ---------------------------------------------------------------------------------------------------------------

const TIMING: NetworkTimingEvidence = {
  startTime: 0,
  domainLookupStart: -1,
  domainLookupEnd: -1,
  connectStart: -1,
  secureConnectionStart: -1,
  connectEnd: -1,
  requestStart: -1,
  responseStart: -1,
  responseEnd: -1,
};

const request = (overrides: Partial<NetworkRequestEvidence> = {}): NetworkRequestEvidence => ({
  requestId: 'REQ-000001',
  url: PAGE_URL,
  method: 'GET',
  resourceType: 'document',
  headers: { status: 'OBSERVED', values: {} },
  timing: TIMING,
  redirectFromRequestId: null,
  redirectToRequestId: null,
  redirectChainRequestIds: [],
  truncated: false,
  isNavigationRequest: true,
  isMainFrame: true,
  ...overrides,
});

const response = (overrides: Partial<NetworkResponseEvidence> = {}): NetworkResponseEvidence => ({
  requestId: 'REQ-000001',
  url: PAGE_URL,
  status: 200,
  statusText: 'OK',
  headers: { status: 'OBSERVED', values: {} },
  contentLengthHeader: null,
  timing: TIMING,
  transferSize: { status: 'OBSERVED', headersBytes: 120, bodyBytes: 2_048, totalBytes: 2_168 },
  truncated: false,
  isNavigationRequest: true,
  isMainFrame: true,
  ...overrides,
});

const failure = (overrides: Partial<NetworkFailureEvidence> = {}): NetworkFailureEvidence => ({
  requestId: 'REQ-000002',
  url: `${ORIGIN}/assets/app.js`,
  method: 'GET',
  resourceType: 'script',
  errorText: 'net::ERR_CONNECTION_REFUSED',
  timing: TIMING,
  truncated: false,
  isNavigationRequest: false,
  isMainFrame: true,
  ...overrides,
});

const networkRecord = (payload: Partial<NetworkEvidence>, sequence = 1): EvidenceRecordFor<'network'> => ({
  evidenceId: createEvidenceId('network', sequence),
  type: 'network',
  pageId: PAGE_ID,
  viewport: 'desktop',
  observedAt: OBSERVED_AT,
  payload: {
    requests: [request()],
    responses: [response()],
    failures: [],
    omittedRequestCount: 0,
    omittedResponseCount: 0,
    omittedFailureCount: 0,
    ...payload,
  },
});

const pageError = (overrides: Partial<PageErrorEvidence> = {}): PageErrorEvidence => ({
  name: 'TypeError',
  message: 'boom is not a function',
  stack: `TypeError: boom is not a function\n    at ${ORIGIN}/assets/app.js:10:5`,
  truncated: false,
  ...overrides,
});

const consoleRecord = (payload: Partial<ConsoleEvidence>, sequence = 1): EvidenceRecordFor<'console'> => ({
  evidenceId: createEvidenceId('console', sequence),
  type: 'console',
  pageId: PAGE_ID,
  viewport: 'desktop',
  observedAt: OBSERVED_AT,
  payload: {
    consoleMessages: [],
    pageErrors: [],
    omittedConsoleMessageCount: 0,
    omittedPageErrorCount: 0,
    ...payload,
  },
});

const image = (overrides: Partial<ImageDomEvidence> = {}): ImageDomEvidence => ({
  src: '/images/photo.png',
  resolvedUrl: `${ORIGIN}/images/photo.png`,
  alt: '写真',
  complete: true,
  naturalWidth: 640,
  naturalHeight: 480,
  truncated: false,
  ...overrides,
});

const field = (overrides: Partial<FormFieldEvidence> = {}): FormFieldEvidence => ({
  type: 'text',
  name: 'name',
  required: true,
  visible: true,
  labels: ['お名前'],
  hasAriaLabel: false,
  hasAriaLabelledby: false,
  hasTitle: false,
  truncated: false,
  ...overrides,
});

const form = (overrides: Partial<FormDomEvidence> = {}): FormDomEvidence => ({
  method: 'get',
  action: '/search',
  fields: [field()],
  submitControls: [],
  omittedFieldCount: 0,
  omittedSubmitControlCount: 0,
  truncated: false,
  ...overrides,
});

const domPayload = (overrides: Partial<DomEvidence> = {}): DomEvidence => ({
  pageId: PAGE_ID,
  scrollPosition: { scrollX: 0, scrollY: 0 },
  title: '症状の一覧',
  metaDescription: null,
  canonicalUrl: PAGE_URL,
  lang: 'ja',
  headings: [],
  visibleText: {
    source: 'BODY_FALLBACK',
    text: '症状の一覧 交通事故の後の痛みについて',
    truncated: false,
    nodeLimitReached: false,
    ariaHiddenText: '',
    regions: [],
    omittedRegionCount: 0,
  },
  images: [image()],
  forms: [form()],
  unassociatedFields: [],
  duplicateIds: [],
  truncation: {
    documentFields: { title: false, metaDescription: false, canonicalUrl: false, lang: false },
    omittedHeadingCount: 0,
    omittedImageCount: 0,
    omittedFormCount: 0,
    omittedUnassociatedFieldCount: 0,
    omittedDuplicateIdCount: 0,
  },
  ...overrides,
});

const domRecord = (overrides: Partial<DomEvidence> = {}, sequence = 1): EvidenceRecordFor<'dom'> => ({
  evidenceId: createEvidenceId('dom', sequence),
  type: 'dom',
  pageId: PAGE_ID,
  viewport: 'desktop',
  observedAt: OBSERVED_AT,
  payload: domPayload(overrides),
});

const internalLink = (anchorText: string, path: string): LinkEvidence => ({
  sourcePageId: PAGE_ID,
  anchorText,
  ariaLabel: null,
  title: null,
  rawHref: path,
  normalized: { ok: true, url: `${ORIGIN}${path}` as NormalizedHttpUrlEvidence },
  admission: { kind: 'INTERNAL_NAVIGABLE', url: `${ORIGIN}${path}` },
  truncated: false,
});

const externalLink = (url: string): LinkEvidence => ({
  sourcePageId: PAGE_ID,
  anchorText: '外部サイト',
  ariaLabel: null,
  title: null,
  rawHref: url,
  normalized: { ok: true, url: url as NormalizedHttpUrlEvidence },
  admission: { kind: 'EXTERNAL_RECORD_ONLY', url },
  truncated: false,
});

const specialSchemeLink = (rawHref: string, scheme: string): LinkEvidence => ({
  sourcePageId: PAGE_ID,
  anchorText: '連絡先',
  ariaLabel: null,
  title: null,
  rawHref,
  normalized: { ok: false, rawUrl: rawHref, reason: 'UNSUPPORTED_SCHEME' },
  admission: { kind: 'SPECIAL_SCHEME_RECORD_ONLY', rawUrl: rawHref, scheme },
  truncated: false,
});

const rejectedLink = (rawHref: string, reason: 'INVALID_URL' | 'CREDENTIALS_NOT_ALLOWED' | 'URL_TOO_LONG'): LinkEvidence => ({
  sourcePageId: PAGE_ID,
  anchorText: '壊れたリンク',
  ariaLabel: null,
  title: null,
  rawHref,
  normalized: { ok: false, rawUrl: rawHref, reason },
  admission: { kind: 'REJECTED_INVALID', rawUrl: rawHref, reason },
  truncated: false,
});

const linkRecord = (links: readonly LinkEvidence[], sequence = 1): EvidenceRecordFor<'link'> => ({
  evidenceId: createEvidenceId('link', sequence),
  type: 'link',
  pageId: PAGE_ID,
  viewport: 'desktop',
  observedAt: OBSERVED_AT,
  payload: { links, omittedLinkCount: 0 } satisfies LinkDiscoveryEvidence,
});

// ---------------------------------------------------------------------------------------------------------------
// 評価
// ---------------------------------------------------------------------------------------------------------------

const input = (evidence: readonly EvidenceRecord[]): PageRuleInput => ({
  pageId: PAGE_ID,
  pageUrl: PAGE_URL,
  viewport: 'desktop',
  evidence,
});

/** TECHNICAL_RULES だけを Rule Engine で評価する。どの Rule も失敗しないことを、あわせて確かめる。 */
const evaluate = (evidence: readonly EvidenceRecord[]): readonly Finding[] => {
  const result = new RuleEngine({ targetId: TARGET_ID, firstFindingSequence: 0, catalog: TECHNICAL_RULES })
    .evaluate(input(evidence));
  expect(result.failures).toEqual([]);
  return result.findings;
};

const findingsOf = (findings: readonly Finding[], ruleId: string): readonly Finding[] =>
  findings.filter((finding) => finding.ruleId === ruleId);

/** 問題のない Evidence（どの Rule も成立しない）。 */
const healthyEvidence = (): readonly EvidenceRecord[] => [
  networkRecord({}),
  consoleRecord({}),
  domRecord(),
  linkRecord([internalLink('交通事故', '/symptoms'), externalLink('https://external.test/')]),
];

const EXPECTED_RULES: readonly (readonly [string, FindingCategory, Severity])[] = [
  ['HTTP_4XX', 'HTTP', 'ERROR'],
  ['HTTP_5XX', 'HTTP', 'ERROR'],
  ['REDIRECT_LOOP', 'HTTP', 'ERROR'],
  ['EMPTY_HTTP_RESPONSE', 'HTTP', 'ERROR'],
  ['INVALID_INTERNAL_URL', 'LINK', 'WARN'],
  ['UNSUPPORTED_URL_SCHEME', 'LINK', 'INFO'],
  ['RESOURCE_4XX', 'RESOURCE', 'ERROR'],
  ['RESOURCE_5XX', 'RESOURCE', 'ERROR'],
  ['SCRIPT_LOAD_FAILED', 'RESOURCE', 'ERROR'],
  ['STYLESHEET_LOAD_FAILED', 'RESOURCE', 'ERROR'],
  ['IMAGE_LOAD_FAILED', 'RESOURCE', 'ERROR'],
  ['PAGE_ERROR', 'JAVASCRIPT', 'ERROR'],
  ['MISSING_TITLE', 'DOM', 'WARN'],
  ['EMPTY_TITLE', 'DOM', 'WARN'],
  ['MISSING_HTML_LANG', 'DOM', 'WARN'],
  ['EMPTY_VISIBLE_CONTENT', 'DOM', 'ERROR'],
  ['DUPLICATE_ELEMENT_ID', 'DOM', 'WARN'],
  ['INVALID_CANONICAL_URL', 'DOM', 'WARN'],
  ['FORM_WITHOUT_ACTION', 'FORM', 'INFO'],
  ['UNLABELED_REQUIRED_CONTROL', 'FORM', 'WARN'],
];

// ---------------------------------------------------------------------------------------------------------------
// 登録
// ---------------------------------------------------------------------------------------------------------------

describe('TECHNICAL_RULES の登録', () => {
  it('設計書 5.1 の担当の Rule を、category・severity・version とともに登録している', () => {
    const registered = TECHNICAL_RULES.map((rule) => [rule.ruleId, rule.category, rule.severity] as const);
    expect(registered).toEqual(EXPECTED_RULES);
    for (const rule of TECHNICAL_RULES) {
      expect(rule.version).toBe(1);
      expect(rule.ruleIdPrefix).toBeUndefined();
    }
  });

  it('担当の Rule は、すべて RULE_CATALOG に含まれる', () => {
    const catalogRuleIds = new Set(RULE_CATALOG.map((rule) => rule.ruleId));
    for (const [ruleId] of EXPECTED_RULES) {
      expect(catalogRuleIds.has(ruleId)).toBe(true);
    }
  });

  it('Cross-page rule の BROKEN_INTERNAL_LINK と TARGET_NAVIGATION_FAILED は、ここに登録しない', () => {
    const ruleIds = TECHNICAL_RULES.map((rule) => rule.ruleId);
    expect(ruleIds).not.toContain('BROKEN_INTERNAL_LINK');
    expect(ruleIds).not.toContain('TARGET_NAVIGATION_FAILED');
  });
});

describe('TECHNICAL_RULES の共通の振る舞い', () => {
  it('Evidence のない入力からは、例外を投げずに Finding を作らない', () => {
    expect(evaluate([])).toEqual([]);
  });

  it('問題のない Evidence からは Finding を作らない', () => {
    const findings = evaluate(healthyEvidence());
    expect(findings).toEqual([]);
    expect(TECHNICAL_RULES.length).toBeGreaterThan(0);
  });

  it('「交通事故」というリンク文言で /symptoms を指すリンクは、意味の判断をせず Finding にしない', () => {
    const findings = evaluate([linkRecord([internalLink('交通事故', '/symptoms')])]);
    expect(findings).toEqual([]);
    expect(TECHNICAL_RULES.map((rule) => rule.ruleId)).toContain('INVALID_INTERNAL_URL');
  });

  it('Finding の文言は日本語で、Evidence を参照する', () => {
    const findings = evaluate([domRecord({ title: null })]);
    const [finding] = findingsOf(findings, 'MISSING_TITLE');
    expect(finding?.message).toMatch(/[぀-ヿ]/u);
    expect(finding?.evidenceRefs).toEqual([createEvidenceId('dom', 1)]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------------------------

describe('HTTP_4XX と HTTP_5XX', () => {
  it('メインフレームのナビゲーション応答が 404 なら HTTP_4XX、503 なら HTTP_5XX を作る', () => {
    const notFound = evaluate([networkRecord({ responses: [response({ status: 404, statusText: 'Not Found' })] })]);
    expect(findingsOf(notFound, 'HTTP_4XX')).toHaveLength(1);
    expect(findingsOf(notFound, 'HTTP_4XX')[0]).toMatchObject({ category: 'HTTP', severity: 'ERROR' });
    expect(findingsOf(notFound, 'HTTP_4XX')[0]?.message).toContain('404');
    expect(findingsOf(notFound, 'HTTP_4XX')[0]?.message).toContain(PAGE_URL);
    expect(findingsOf(notFound, 'HTTP_5XX')).toEqual([]);

    const unavailable = evaluate([networkRecord({ responses: [response({ status: 503, statusText: '' })] })]);
    expect(findingsOf(unavailable, 'HTTP_5XX')).toHaveLength(1);
    expect(findingsOf(unavailable, 'HTTP_5XX')[0]?.message).toContain('503');
    expect(findingsOf(unavailable, 'HTTP_4XX')).toEqual([]);
  });

  it('境界の値（399・400・499・500・599・600）を正しく分ける', () => {
    const statuses = [399, 400, 499, 500, 599, 600];
    const findings = evaluate([
      networkRecord({
        requests: [],
        responses: statuses.map((status) => response({ status, url: `${ORIGIN}/status/${status}` })),
      }),
    ]);
    const clientMessages = findingsOf(findings, 'HTTP_4XX').map((finding) => finding.message).join('\n');
    const serverMessages = findingsOf(findings, 'HTTP_5XX').map((finding) => finding.message).join('\n');
    expect(findingsOf(findings, 'HTTP_4XX')).toHaveLength(2);
    expect(findingsOf(findings, 'HTTP_5XX')).toHaveLength(2);
    expect(clientMessages).toContain(`${ORIGIN}/status/400`);
    expect(clientMessages).toContain(`${ORIGIN}/status/499`);
    expect(serverMessages).toContain(`${ORIGIN}/status/500`);
    expect(serverMessages).toContain(`${ORIGIN}/status/599`);
  });

  it('iframe の文書、サブリソース、フレームの分からない応答の 4xx・5xx では、HTTP_4XX・HTTP_5XX を作らない', () => {
    const findings = evaluate([
      networkRecord({
        requests: [],
        responses: [
          response({ status: 404, isMainFrame: false, isNavigationRequest: true, url: `${ORIGIN}/frame` }),
          response({ status: 500, isMainFrame: true, isNavigationRequest: false, url: `${ORIGIN}/api` }),
          response({ status: 502, isMainFrame: null, isNavigationRequest: true, url: `${ORIGIN}/worker` }),
        ],
      }),
    ]);
    expect(findingsOf(findings, 'HTTP_4XX')).toEqual([]);
    expect(findingsOf(findings, 'HTTP_5XX')).toEqual([]);
  });

  it('同じURLの応答が複数あっても、1つの Finding にまとめる', () => {
    const findings = evaluate([
      networkRecord({
        responses: [
          response({ requestId: 'REQ-000001', status: 404 }),
          response({ requestId: 'REQ-000002', status: 404 }),
        ],
      }),
    ]);
    expect(findingsOf(findings, 'HTTP_4XX')).toHaveLength(1);
  });
});

describe('REDIRECT_LOOP', () => {
  const chainRequests = (urls: readonly string[]): readonly NetworkRequestEvidence[] =>
    urls.map((url, index) => request({
      requestId: `REQ-00000${index + 1}`,
      url,
      redirectFromRequestId: index === 0 ? null : `REQ-00000${index}`,
      redirectToRequestId: index === urls.length - 1 ? null : `REQ-00000${index + 2}`,
      redirectChainRequestIds: urls.slice(0, index).map((_url, chainIndex) => `REQ-00000${chainIndex + 1}`),
    }));

  it('メインフレームのリダイレクトの連鎖に同じURLが再び現れたら、1つの Finding を作る', () => {
    const findings = evaluate([
      networkRecord({
        requests: chainRequests([`${ORIGIN}/a`, `${ORIGIN}/b`, `${ORIGIN}/a`, `${ORIGIN}/b`]),
        responses: [],
      }),
    ]);
    const loops = findingsOf(findings, 'REDIRECT_LOOP');
    expect(loops).toHaveLength(1);
    expect(loops[0]).toMatchObject({ category: 'HTTP', severity: 'ERROR' });
    expect(loops[0]?.message).toContain(`${ORIGIN}/a`);
  });

  it('同じURLが再び現れないリダイレクトの連鎖と、リダイレクトのない要求では作らない', () => {
    const findings = evaluate([
      networkRecord({
        requests: [
          ...chainRequests([`${ORIGIN}/a`, `${ORIGIN}/b`, `${ORIGIN}/c`]),
          request({ requestId: 'REQ-000009', url: `${ORIGIN}/a`, isNavigationRequest: false, resourceType: 'fetch' }),
        ],
        responses: [],
      }),
    ]);
    expect(findingsOf(findings, 'REDIRECT_LOOP')).toEqual([]);
  });

  it('サブリソースのリダイレクトの連鎖や、切り詰めたURLどうしの一致では作らない', () => {
    const subresource = chainRequests([`${ORIGIN}/x`, `${ORIGIN}/y`, `${ORIGIN}/x`])
      .map((entry) => ({ ...entry, isNavigationRequest: false, resourceType: 'image' }));
    const truncated = chainRequests([`${ORIGIN}/long`, `${ORIGIN}/other`, `${ORIGIN}/long`])
      .map((entry) => ({ ...entry, requestId: entry.requestId.replace('REQ-', 'REQ-T'), truncated: true }))
      .map((entry, index, all) => ({
        ...entry,
        redirectFromRequestId: index === 0 ? null : all[index - 1]?.requestId ?? null,
        redirectToRequestId: all[index + 1]?.requestId ?? null,
        redirectChainRequestIds: all.slice(0, index).map((previous) => previous.requestId),
      }));
    expect(findingsOf(evaluate([networkRecord({ requests: subresource, responses: [] })]), 'REDIRECT_LOOP')).toEqual([]);
    expect(findingsOf(evaluate([networkRecord({ requests: truncated, responses: [] })]), 'REDIRECT_LOOP')).toEqual([]);
  });
});

describe('EMPTY_HTTP_RESPONSE', () => {
  it('メインフレームの応答が 200 番台で、本文の大きさが 0 と観測されたら作る', () => {
    const findings = evaluate([
      networkRecord({
        responses: [
          response({ status: 200, transferSize: { status: 'OBSERVED', headersBytes: 90, bodyBytes: 0, totalBytes: 90 } }),
        ],
      }),
    ]);
    const empty = findingsOf(findings, 'EMPTY_HTTP_RESPONSE');
    expect(empty).toHaveLength(1);
    expect(empty[0]).toMatchObject({ category: 'HTTP', severity: 'ERROR' });
    expect(empty[0]?.message).toContain('200');
    expect(empty[0]?.message).toContain('0');
  });

  it('本文の大きさを観測できない場合、本文がある場合、200 番台でない場合、サブリソースの場合は作らない', () => {
    const emptyBody = { status: 'OBSERVED', headersBytes: 90, bodyBytes: 0, totalBytes: 90 } as const;
    const findings = evaluate([
      networkRecord({
        requests: [],
        responses: [
          response({ url: `${ORIGIN}/not-observed`, transferSize: { status: 'NOT_OBSERVED' } }),
          response({ url: `${ORIGIN}/failed`, transferSize: { status: 'FAILED', errorText: 'boom' } }),
          response({ url: `${ORIGIN}/body` }),
          response({ url: `${ORIGIN}/redirect`, status: 301, transferSize: emptyBody }),
          response({ url: `${ORIGIN}/sub`, isNavigationRequest: false, transferSize: emptyBody }),
          response({ url: `${ORIGIN}/frame`, isMainFrame: false, transferSize: emptyBody }),
        ],
      }),
    ]);
    expect(findingsOf(findings, 'EMPTY_HTTP_RESPONSE')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// LINK
// ---------------------------------------------------------------------------------------------------------------

describe('INVALID_INTERNAL_URL', () => {
  it('正規化できない、ページと同じOriginの href や解析できない href のリンクで作る', () => {
    const findings = evaluate([
      linkRecord([
        rejectedLink('http://exa mple.invalid/', 'INVALID_URL'),
        rejectedLink(`http://[REDACTED]@127.0.0.1:4173/private`, 'CREDENTIALS_NOT_ALLOWED'),
      ]),
    ]);
    const invalid = findingsOf(findings, 'INVALID_INTERNAL_URL');
    expect(invalid).toHaveLength(2);
    expect(invalid[0]).toMatchObject({ category: 'LINK', severity: 'WARN' });
    const messages = invalid.map((finding) => finding.message).join('\n');
    expect(messages).toContain('INVALID_URL');
    expect(messages).toContain('CREDENTIALS_NOT_ALLOWED');
    expect(messages).toContain('http://exa mple.invalid/');
  });

  it('受け入れた内部リンク、外部リンク、特別な scheme のリンク、別Originの不正なリンクでは作らない', () => {
    const findings = evaluate([
      linkRecord([
        internalLink('トップ', '/'),
        externalLink('https://external.test/page'),
        specialSchemeLink('tel:0120000000', 'tel'),
        rejectedLink('https://[REDACTED]@external.test/', 'CREDENTIALS_NOT_ALLOWED'),
      ]),
    ]);
    expect(findingsOf(findings, 'INVALID_INTERNAL_URL')).toEqual([]);
  });
});

describe('UNSUPPORTED_URL_SCHEME', () => {
  it('http・https 以外の scheme のリンクを、事実の記録として INFO にする', () => {
    const findings = evaluate([
      linkRecord([
        specialSchemeLink('tel:0120000000', 'tel'),
        specialSchemeLink('mailto:info@example.invalid', 'mailto'),
        specialSchemeLink('tel:0120000000', 'tel'),
      ]),
    ]);
    const special = findingsOf(findings, 'UNSUPPORTED_URL_SCHEME');
    expect(special).toHaveLength(2);
    expect(special[0]).toMatchObject({ category: 'LINK', severity: 'INFO' });
    const messages = special.map((finding) => finding.message).join('\n');
    expect(messages).toContain('tel:0120000000');
    expect(messages).toContain('mailto');
  });

  it('http・https のリンクでは作らない', () => {
    const findings = evaluate([linkRecord([internalLink('会社概要', '/about'), externalLink('https://external.test/')])]);
    expect(findingsOf(findings, 'UNSUPPORTED_URL_SCHEME')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// RESOURCE
// ---------------------------------------------------------------------------------------------------------------

describe('RESOURCE_4XX と RESOURCE_5XX', () => {
  it('サブリソースと iframe の文書の応答の 4xx・5xx で作り、URL・ステータス・種類を文言に含める', () => {
    const findings = evaluate([
      networkRecord({
        requests: [
          request(),
          request({ requestId: 'REQ-000002', url: `${ORIGIN}/img/a.png`, resourceType: 'image', isNavigationRequest: false }),
          request({ requestId: 'REQ-000003', url: `${ORIGIN}/api/data`, resourceType: 'fetch', isNavigationRequest: false }),
          request({ requestId: 'REQ-000004', url: `${ORIGIN}/frame`, isMainFrame: false }),
        ],
        responses: [
          response(),
          response({ requestId: 'REQ-000002', url: `${ORIGIN}/img/a.png`, status: 404, isNavigationRequest: false }),
          response({ requestId: 'REQ-000003', url: `${ORIGIN}/api/data`, status: 500, isNavigationRequest: false }),
          response({ requestId: 'REQ-000004', url: `${ORIGIN}/frame`, status: 403, isMainFrame: false }),
        ],
      }),
    ]);
    const clientErrors = findingsOf(findings, 'RESOURCE_4XX');
    const serverErrors = findingsOf(findings, 'RESOURCE_5XX');
    expect(clientErrors).toHaveLength(2);
    expect(serverErrors).toHaveLength(1);
    expect(clientErrors[0]).toMatchObject({ category: 'RESOURCE', severity: 'ERROR' });
    const clientMessages = clientErrors.map((finding) => finding.message).join('\n');
    expect(clientMessages).toContain(`${ORIGIN}/img/a.png`);
    expect(clientMessages).toContain('404');
    expect(clientMessages).toContain('image');
    expect(serverErrors[0]?.message).toContain('500');
    expect(findingsOf(findings, 'HTTP_4XX')).toEqual([]);
    expect(findingsOf(findings, 'HTTP_5XX')).toEqual([]);
  });

  it('メインフレームのナビゲーション応答、サブリソースの成功とリダイレクトでは作らない', () => {
    const findings = evaluate([
      networkRecord({
        requests: [],
        responses: [
          response({ status: 404 }),
          response({ requestId: 'REQ-000002', url: `${ORIGIN}/a.css`, status: 200, isNavigationRequest: false }),
          response({ requestId: 'REQ-000003', url: `${ORIGIN}/b.css`, status: 304, isNavigationRequest: false }),
          response({ requestId: 'REQ-000004', url: `${ORIGIN}/c.css`, status: 301, isNavigationRequest: false }),
        ],
      }),
    ]);
    expect(findingsOf(findings, 'RESOURCE_4XX')).toEqual([]);
    expect(findingsOf(findings, 'RESOURCE_5XX')).toEqual([]);
  });
});

describe('SCRIPT_LOAD_FAILED と STYLESHEET_LOAD_FAILED', () => {
  it('script と stylesheet の読み込みの失敗で、それぞれ作り、URL とエラーを文言に含める', () => {
    const findings = evaluate([
      networkRecord({
        failures: [
          failure(),
          failure({ requestId: 'REQ-000003', url: `${ORIGIN}/assets/site.css`, resourceType: 'stylesheet', errorText: 'net::ERR_EMPTY_RESPONSE' }),
        ],
      }),
    ]);
    const scripts = findingsOf(findings, 'SCRIPT_LOAD_FAILED');
    const stylesheets = findingsOf(findings, 'STYLESHEET_LOAD_FAILED');
    expect(scripts).toHaveLength(1);
    expect(stylesheets).toHaveLength(1);
    expect(scripts[0]).toMatchObject({ category: 'RESOURCE', severity: 'ERROR' });
    expect(scripts[0]?.message).toContain(`${ORIGIN}/assets/app.js`);
    expect(scripts[0]?.message).toContain('net::ERR_CONNECTION_REFUSED');
    expect(stylesheets[0]?.message).toContain(`${ORIGIN}/assets/site.css`);
    expect(stylesheets[0]?.message).toContain('net::ERR_EMPTY_RESPONSE');
  });

  it('script・stylesheet 以外の失敗では作らない', () => {
    const findings = evaluate([
      networkRecord({
        failures: [
          failure({ resourceType: 'fetch', url: `${ORIGIN}/api` }),
          failure({ resourceType: 'font', url: `${ORIGIN}/font.woff2` }),
        ],
      }),
    ]);
    expect(findingsOf(findings, 'SCRIPT_LOAD_FAILED')).toEqual([]);
    expect(findingsOf(findings, 'STYLESHEET_LOAD_FAILED')).toEqual([]);
  });
});

describe('IMAGE_LOAD_FAILED', () => {
  it('画像の読み込みの失敗で作る', () => {
    const findings = evaluate([
      networkRecord({ failures: [failure({ resourceType: 'image', url: `${ORIGIN}/img/missing.png`, errorText: 'net::ERR_FAILED' })] }),
    ]);
    const images = findingsOf(findings, 'IMAGE_LOAD_FAILED');
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ category: 'RESOURCE', severity: 'ERROR' });
    expect(images[0]?.message).toContain(`${ORIGIN}/img/missing.png`);
    expect(images[0]?.message).toContain('net::ERR_FAILED');
  });

  it('complete かつ naturalWidth が 0 の画像で作り、同じURLの読み込みの失敗と1つにまとめる', () => {
    const brokenUrl = `${ORIGIN}/img/broken.png`;
    const findings = evaluate([
      networkRecord({ failures: [failure({ resourceType: 'image', url: brokenUrl, errorText: 'net::ERR_FAILED' })] }),
      domRecord({ images: [image({ src: '/img/broken.png', resolvedUrl: brokenUrl, naturalWidth: 0, naturalHeight: 0 })] }),
    ]);
    const images = findingsOf(findings, 'IMAGE_LOAD_FAILED');
    expect(images).toHaveLength(1);
    expect(images[0]?.evidenceRefs).toEqual([createEvidenceId('dom', 1), createEvidenceId('network', 1)]);
    expect(images[0]?.message).toContain('naturalWidth');
  });

  it('読み込み中（complete でない）の画像、大きさのある画像、src のない画像では作らない', () => {
    const findings = evaluate([
      domRecord({
        images: [
          image({ complete: false, naturalWidth: 0, naturalHeight: 0, resolvedUrl: `${ORIGIN}/img/lazy.png` }),
          image(),
          image({ src: null, resolvedUrl: null, naturalWidth: 0, naturalHeight: 0 }),
        ],
      }),
    ]);
    expect(findingsOf(findings, 'IMAGE_LOAD_FAILED')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// JAVASCRIPT
// ---------------------------------------------------------------------------------------------------------------

describe('PAGE_ERROR', () => {
  it('捕捉されない例外で作り、同じ message・source・stack のものを1つにまとめて回数を文言に含める', () => {
    const findings = evaluate([
      consoleRecord({
        pageErrors: [
          pageError(),
          pageError(),
          pageError({ message: 'other failure', stack: null }),
        ],
      }),
    ]);
    const errors = findingsOf(findings, 'PAGE_ERROR');
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({ category: 'JAVASCRIPT', severity: 'ERROR' });
    const repeated = errors.find((finding) => finding.message.includes('boom is not a function'));
    expect(repeated?.message).toContain('2');
    expect(errors.some((finding) => finding.message.includes('other failure'))).toBe(true);
  });

  it('message が同じでも stack が異なる例外は、別の Finding にする', () => {
    const findings = evaluate([
      consoleRecord({
        pageErrors: [
          pageError(),
          pageError({ stack: `TypeError: boom is not a function\n    at ${ORIGIN}/assets/other.js:3:1` }),
        ],
      }),
    ]);
    expect(findingsOf(findings, 'PAGE_ERROR')).toHaveLength(2);
  });

  it('pageerror がなければ、console.error があっても作らない', () => {
    const findings = evaluate([
      consoleRecord({
        consoleMessages: [{ type: 'error', text: 'console failure', location: { url: PAGE_URL, lineNumber: 1, columnNumber: 1 }, truncated: false }],
      }),
    ]);
    expect(findingsOf(findings, 'PAGE_ERROR')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------------------------------------------

describe('MISSING_TITLE と EMPTY_TITLE', () => {
  it('title がなければ MISSING_TITLE、空白だけなら EMPTY_TITLE を作る', () => {
    const missing = evaluate([domRecord({ title: null })]);
    expect(findingsOf(missing, 'MISSING_TITLE')).toHaveLength(1);
    expect(findingsOf(missing, 'MISSING_TITLE')[0]).toMatchObject({ category: 'DOM', severity: 'WARN' });
    expect(findingsOf(missing, 'EMPTY_TITLE')).toEqual([]);

    for (const title of ['', '   ']) {
      const empty = evaluate([domRecord({ title })]);
      expect(findingsOf(empty, 'EMPTY_TITLE')).toHaveLength(1);
      expect(findingsOf(empty, 'EMPTY_TITLE')[0]).toMatchObject({ category: 'DOM', severity: 'WARN' });
      expect(findingsOf(empty, 'MISSING_TITLE')).toEqual([]);
    }
  });

  it('空でない title では作らない', () => {
    const findings = evaluate([domRecord({ title: 'ページ' })]);
    expect(findingsOf(findings, 'MISSING_TITLE')).toEqual([]);
    expect(findingsOf(findings, 'EMPTY_TITLE')).toEqual([]);
  });
});

describe('MISSING_HTML_LANG', () => {
  it('lang がないか、空白だけなら作る', () => {
    for (const lang of [null, '', '  ']) {
      const findings = findingsOf(evaluate([domRecord({ lang })]), 'MISSING_HTML_LANG');
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ category: 'DOM', severity: 'WARN' });
    }
  });

  it('lang があれば作らない', () => {
    expect(findingsOf(evaluate([domRecord({ lang: 'ja-JP' })]), 'MISSING_HTML_LANG')).toEqual([]);
  });
});

describe('EMPTY_VISIBLE_CONTENT', () => {
  const visibleText = (text: string, nodeLimitReached: boolean): DomEvidence['visibleText'] => ({
    source: 'BODY_FALLBACK',
    text,
    truncated: false,
    nodeLimitReached,
    ariaHiddenText: '',
    regions: [],
    omittedRegionCount: 0,
  });

  it('可視テキストが空で、走査が上限に達していなければ作る', () => {
    for (const text of ['', ' \n\t ']) {
      const findings = findingsOf(evaluate([domRecord({ visibleText: visibleText(text, false) })]), 'EMPTY_VISIBLE_CONTENT');
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ category: 'DOM', severity: 'ERROR' });
    }
  });

  it('走査が上限に達していた場合と、可視テキストがある場合は作らない', () => {
    expect(findingsOf(evaluate([domRecord({ visibleText: visibleText('', true) })]), 'EMPTY_VISIBLE_CONTENT')).toEqual([]);
    expect(findingsOf(evaluate([domRecord({ visibleText: visibleText('本文', false) })]), 'EMPTY_VISIBLE_CONTENT')).toEqual([]);
  });
});

describe('DUPLICATE_ELEMENT_ID', () => {
  it('重複している id ごとに作り、id と件数を文言に含める', () => {
    const findings = evaluate([
      domRecord({
        duplicateIds: [
          { id: 'main', count: 2, truncated: false },
          { id: 'menu', count: 3, truncated: false },
        ],
      }),
    ]);
    const duplicates = findingsOf(findings, 'DUPLICATE_ELEMENT_ID');
    expect(duplicates).toHaveLength(2);
    expect(duplicates[0]).toMatchObject({ category: 'DOM', severity: 'WARN' });
    const menu = duplicates.find((finding) => finding.message.includes('menu'));
    expect(menu?.message).toContain('3');
  });

  it('重複がなければ作らない', () => {
    expect(findingsOf(evaluate([domRecord({ duplicateIds: [] })]), 'DUPLICATE_ELEMENT_ID')).toEqual([]);
  });
});

describe('INVALID_CANONICAL_URL', () => {
  it('canonical の href を正規化できなければ作り、href と理由を文言に含める', () => {
    const cases: readonly [string, string][] = [
      ['http://exa mple.invalid/', 'INVALID_URL'],
      ['mailto:info@example.invalid', 'UNSUPPORTED_SCHEME'],
      [`http://user:secret@127.0.0.1:4173/`, 'CREDENTIALS_NOT_ALLOWED'],
    ];
    for (const [canonicalUrl, reason] of cases) {
      const findings = findingsOf(evaluate([domRecord({ canonicalUrl })]), 'INVALID_CANONICAL_URL');
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ category: 'DOM', severity: 'WARN' });
      expect(findings[0]?.message).toContain(reason);
      expect(findings[0]?.message).not.toContain('secret');
    }
  });

  it('正規化できる canonical（相対URL・別Originを含む）、canonical がない場合、切り詰めた canonical では作らない', () => {
    const truncatedFields = { title: false, metaDescription: false, canonicalUrl: true, lang: false };
    const truncatedCanonical = domPayload().truncation;
    const candidates: readonly Partial<DomEvidence>[] = [
      { canonicalUrl: '/technical/page' },
      { canonicalUrl: 'https://external.test/page' },
      { canonicalUrl: null },
      { canonicalUrl: 'http://exa mple', truncation: { ...truncatedCanonical, documentFields: truncatedFields } },
    ];
    for (const overrides of candidates) {
      expect(findingsOf(evaluate([domRecord(overrides)]), 'INVALID_CANONICAL_URL')).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// FORM
// ---------------------------------------------------------------------------------------------------------------

describe('FORM_WITHOUT_ACTION', () => {
  it('action がない（空の）form で、事実の記録として INFO を作る', () => {
    const findings = evaluate([domRecord({ forms: [form({ action: '', method: 'post' }), form()] })]);
    const forms = findingsOf(findings, 'FORM_WITHOUT_ACTION');
    expect(forms).toHaveLength(1);
    expect(forms[0]).toMatchObject({ category: 'FORM', severity: 'INFO' });
    expect(forms[0]?.message).toContain('post');
  });

  it('action のある form では作らない', () => {
    expect(findingsOf(evaluate([domRecord({ forms: [form({ action: '/contact' })] })]), 'FORM_WITHOUT_ACTION')).toEqual([]);
  });
});

describe('UNLABELED_REQUIRED_CONTROL', () => {
  const unlabeled = (overrides: Partial<FormFieldEvidence> = {}): FormFieldEvidence => field({ labels: [], ...overrides });

  it('form の中と外の、可視で required の、名前の手がかりがない入力欄で作る', () => {
    const findings = evaluate([
      domRecord({
        forms: [form({ fields: [unlabeled({ name: 'email', type: 'email' }), field()] })],
        unassociatedFields: [unlabeled({ name: 'phone', type: 'tel' })],
      }),
    ]);
    const controls = findingsOf(findings, 'UNLABELED_REQUIRED_CONTROL');
    expect(controls).toHaveLength(2);
    expect(controls[0]).toMatchObject({ category: 'FORM', severity: 'WARN' });
    const messages = controls.map((finding) => finding.message).join('\n');
    expect(messages).toContain('email');
    expect(messages).toContain('phone');
  });

  it('labels・aria-label・aria-labelledby・title のどれかがある、required でない、可視でない入力欄では作らない', () => {
    const findings = evaluate([
      domRecord({
        forms: [
          form({
            fields: [
              field(),
              unlabeled({ hasAriaLabel: true }),
              unlabeled({ hasAriaLabelledby: true }),
              unlabeled({ hasTitle: true }),
              unlabeled({ required: false }),
              unlabeled({ visible: false }),
            ],
          }),
        ],
        unassociatedFields: [unlabeled({ visible: false }), unlabeled({ hasTitle: true })],
      }),
    ]);
    expect(findingsOf(findings, 'UNLABELED_REQUIRED_CONTROL')).toEqual([]);
  });

  it('同じ name の入力欄でも、位置が違えば別の Finding にする', () => {
    const findings = evaluate([
      domRecord({
        forms: [form({ fields: [unlabeled({ name: 'q' }), unlabeled({ name: 'q' })] })],
      }),
    ]);
    const controls = findingsOf(findings, 'UNLABELED_REQUIRED_CONTROL');
    expect(controls).toHaveLength(2);
    expect(new Set(controls.map((finding) => finding.fingerprint)).size).toBe(2);
  });
});

describe('ビューポートの分離', () => {
  /**
   * TECHNICAL_RULES のすべての Rule が成立する Evidence。`viewport` と Evidence の番号を指定して作る
   * （同じ入力に、ビューポートの違う同じ内容の Evidence を混ぜるため）。
   */
  const problemEvidence = (viewport: ViewportProfile, sequence: number): readonly EvidenceRecord[] => {
    const loopUrls = [`${ORIGIN}/loop/a`, `${ORIGIN}/loop/b`, `${ORIGIN}/loop/a`];
    const loopRequests = loopUrls.map((url, index) => request({
      requestId: `REQ-L${index + 1}`,
      url,
      redirectFromRequestId: index === 0 ? null : `REQ-L${index}`,
      redirectToRequestId: index === loopUrls.length - 1 ? null : `REQ-L${index + 2}`,
      redirectChainRequestIds: loopUrls.slice(0, index).map((_url, chainIndex) => `REQ-L${chainIndex + 1}`),
    }));
    const records: readonly EvidenceRecord[] = [
      networkRecord({
        requests: [
          ...loopRequests,
          request({ requestId: 'REQ-S1', url: `${ORIGIN}/img/missing.png`, resourceType: 'image', isNavigationRequest: false }),
        ],
        responses: [
          response({ requestId: 'REQ-M1', url: `${ORIGIN}/status/404`, status: 404 }),
          response({ requestId: 'REQ-M2', url: `${ORIGIN}/status/503`, status: 503 }),
          response({
            requestId: 'REQ-M3',
            url: `${ORIGIN}/empty`,
            transferSize: { status: 'OBSERVED', headersBytes: 90, bodyBytes: 0, totalBytes: 90 },
          }),
          response({ requestId: 'REQ-S1', url: `${ORIGIN}/img/missing.png`, status: 404, isNavigationRequest: false }),
          response({ requestId: 'REQ-S2', url: `${ORIGIN}/api/data`, status: 500, isNavigationRequest: false }),
        ],
        failures: [
          failure(),
          failure({ requestId: 'REQ-F2', url: `${ORIGIN}/assets/site.css`, resourceType: 'stylesheet' }),
          failure({ requestId: 'REQ-F3', url: `${ORIGIN}/img/broken.png`, resourceType: 'image' }),
        ],
      }, sequence),
      consoleRecord({ pageErrors: [pageError()] }, sequence),
      domRecord({
        title: null,
        lang: null,
        canonicalUrl: 'http://exa mple.invalid/',
        visibleText: { ...domPayload().visibleText, text: '' },
        duplicateIds: [{ id: 'main', count: 2, truncated: false }],
        forms: [form({ action: '', fields: [field({ labels: [] })] })],
      }, sequence),
      domRecord({ title: '  ' }, sequence + 1),
      linkRecord([rejectedLink('http://exa mple.invalid/', 'INVALID_URL'), specialSchemeLink('tel:0120000000', 'tel')], sequence),
    ];
    return records.map((record) => ({ ...record, viewport }));
  };

  const evaluateIn = (viewport: ViewportProfile, evidence: readonly EvidenceRecord[]): readonly Finding[] => {
    const result = new RuleEngine({ targetId: TARGET_ID, firstFindingSequence: 0, catalog: TECHNICAL_RULES })
      .evaluate({ pageId: PAGE_ID, pageUrl: PAGE_URL, viewport, evidence });
    expect(result.failures).toEqual([]);
    return result.findings;
  };

  const DESKTOP_SEQUENCE = 1;
  const MOBILE_SEQUENCE = 11;
  const ruleIdsOf = (findings: readonly Finding[]): string[] => [...new Set(findings.map((finding) => finding.ruleId))].sort();

  it('（前提）同じビューポートの Evidence なら、TECHNICAL_RULES のすべての Rule が成立する', () => {
    for (const viewport of ['desktop', 'mobile'] as const) {
      const findings = evaluateIn(viewport, problemEvidence(viewport, DESKTOP_SEQUENCE));
      expect(ruleIdsOf(findings)).toEqual(TECHNICAL_RULES.map((rule) => rule.ruleId).sort());
    }
  });

  it('desktop の入力に mobile の Evidence を混ぜても、mobile の Evidence から Finding を作らない', () => {
    const desktopEvidence = problemEvidence('desktop', DESKTOP_SEQUENCE);
    const mobileEvidence = problemEvidence('mobile', MOBILE_SEQUENCE);
    const mobileIds = new Set(mobileEvidence.map((record) => record.evidenceId));

    const mixed = evaluateIn('desktop', [...mobileEvidence, ...desktopEvidence]);
    expect(mixed).toEqual(evaluateIn('desktop', desktopEvidence));
    expect(mixed.flatMap((finding) => finding.evidenceRefs).filter((ref) => mobileIds.has(ref))).toEqual([]);

    // 健全な desktop の Evidence と、問題のある mobile の Evidence だけなら、Finding は1件もない。
    const healthyDesktop = healthyEvidence();
    expect(evaluateIn('desktop', [...healthyDesktop, ...mobileEvidence])).toEqual([]);
  });

  it('mobile の入力に desktop の Evidence だけを渡しても、Finding を作らない', () => {
    expect(evaluateIn('mobile', problemEvidence('desktop', DESKTOP_SEQUENCE))).toEqual([]);
  });
});

describe('fingerprint の安定性', () => {
  it('同じ Evidence を別の順序で与えても、Finding の fingerprint と順序が変わらない', () => {
    const evidence: readonly EvidenceRecord[] = [
      networkRecord({ responses: [response({ status: 404 })], failures: [failure()] }),
      consoleRecord({ pageErrors: [pageError()] }),
      domRecord({ title: null, lang: null, duplicateIds: [{ id: 'x', count: 2, truncated: false }] }),
      linkRecord([specialSchemeLink('tel:0120000000', 'tel')]),
    ];
    const forward = evaluate(evidence);
    const backward = evaluate([...evidence].reverse());
    expect(backward).toEqual(forward);
    expect(forward.length).toBeGreaterThan(0);
  });
});
