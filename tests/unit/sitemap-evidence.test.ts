// R15a（Task 14〜17 の設計書 5.6.2）: metadata の Evidence の記録から、Cross-page rule に渡す sitemap の Evidence を作る。
import { describe, expect, it } from 'vitest';
import type { EvidencePayloadByType, EvidenceRecordFor, PageId } from '../../src/core/contracts.js';
import { createEvidenceId, createPageId } from '../../src/core/ids.js';
import { sitemapEvidenceFromMetadata } from '../../src/crawl/sitemap-evidence.js';

const PAGE_ID: PageId = createPageId(1);
const ORIGIN = 'https://fixture.test';

const sitemapPayload = {
  kind: 'SITEMAP_XML',
  url: `${ORIGIN}/sitemap.xml`,
  outcome: 'OK',
  httpStatus: 200,
  text: '<urlset></urlset>',
  textTruncated: false,
  sitemapUrls: [`${ORIGIN}/`, `${ORIGIN}/about`],
  sitemapUrlsTruncated: false,
} satisfies EvidencePayloadByType['metadata'];

const robotsPayload = {
  kind: 'ROBOTS_TXT',
  url: `${ORIGIN}/robots.txt`,
  outcome: 'OK',
  httpStatus: 200,
  text: 'User-agent: *',
  textTruncated: false,
  sitemapUrls: null,
  sitemapUrlsTruncated: false,
} satisfies EvidencePayloadByType['metadata'];

const metadataRecord = (payload: EvidencePayloadByType['metadata'], sequence = 7): EvidenceRecordFor<'metadata'> => ({
  evidenceId: createEvidenceId('metadata', sequence),
  type: 'metadata',
  pageId: PAGE_ID,
  viewport: null,
  observedAt: '2026-09-24T00:00:00.000Z',
  payload,
});

describe('sitemapEvidenceFromMetadata', () => {
  it('builds the sitemap Evidence from the sitemap.xml metadata record, keeping its Evidence ID and URLs', () => {
    const record = metadataRecord(sitemapPayload);

    const sitemap = sitemapEvidenceFromMetadata(record);

    expect(sitemap).toEqual({ evidenceId: record.evidenceId, urls: sitemapPayload.sitemapUrls, truncated: false });
    expect(Object.isFrozen(sitemap)).toBe(true);
    expect(Object.isFrozen(sitemap?.urls)).toBe(true);
    // 呼び出し側の配列を共有しない。
    expect(sitemap?.urls).not.toBe(sitemapPayload.sitemapUrls);
  });

  it('marks the sitemap Evidence truncated when the sitemap URLs were truncated at the limit', () => {
    const sitemap = sitemapEvidenceFromMetadata(metadataRecord({ ...sitemapPayload, sitemapUrlsTruncated: true }));

    expect(sitemap?.truncated).toBe(true);
  });

  it('does not mark the sitemap Evidence truncated only because the stored text was truncated', () => {
    // sitemap の URL は、切り詰める前の本文から取り出す（`sitemapUrlsTruncated` が URL の一覧の完全さを表す）。
    const sitemap = sitemapEvidenceFromMetadata(metadataRecord({ ...sitemapPayload, textTruncated: true }));

    expect(sitemap?.truncated).toBe(false);
  });

  it.each([
    ['robots.txt', robotsPayload],
    ['a missing sitemap', { ...sitemapPayload, outcome: 'NOT_FOUND', httpStatus: 404, text: null, sitemapUrls: null }],
    ['a failed sitemap', { ...sitemapPayload, outcome: 'FAILED', httpStatus: null, text: null, sitemapUrls: null }],
    ['a sitemap whose URLs were not read', { ...sitemapPayload, sitemapUrls: null }],
  ] as const)('returns null for %s, so that no sitemap rule is evaluated', (_label, payload) => {
    expect(sitemapEvidenceFromMetadata(metadataRecord(payload))).toBeNull();
  });
});
