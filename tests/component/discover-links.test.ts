import { chromium, type Browser, type Page } from 'playwright';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPageId } from '../../src/core/ids.js';
import type { CrawlCandidate } from '../../src/crawl/crawl-queue.js';
import { discoverLinks } from '../../src/crawl/discover-links.js';

describe('discoverLinks', () => {
  let browser: Browser | undefined;
  let page: Page;

  beforeEach(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
  });

  afterEach(async () => {
    if (browser !== undefined) {
      await browser.close();
    }
  });

  it('preserves canonical anchor evidence and classifies internal, external, special, and invalid targets', async () => {
    await page.setContent(`
      <base href="https://example.test/current/">
      <a href="/pricing?utm_source=ad&page=2#top" aria-label="Pricing overview" title="Pricing title"> Pricing <strong>plans</strong> </a>
      <a href="https://external.test/contact">External contact</a>
      <a href="mailto:help@example.test">Email us</a>
      <a href="http://[::1">Invalid target</a>
    `);

    const sourcePageId = createPageId(3);
    const links = await discoverLinks(page, sourcePageId, {
      allowedOrigins: new Set(['https://example.test']),
      allowedQueryParameters: new Set(['page']),
    });

    expect(links).toEqual([
      {
        sourcePageId,
        anchorText: 'Pricing plans',
        ariaLabel: 'Pricing overview',
        title: 'Pricing title',
        rawHref: '/pricing?utm_source=ad&page=2#top',
        normalized: { ok: true, url: 'https://example.test/pricing?page=2' },
        admission: { kind: 'INTERNAL_NAVIGABLE', url: 'https://example.test/pricing?page=2' },
      },
      {
        sourcePageId,
        anchorText: 'External contact',
        ariaLabel: null,
        title: null,
        rawHref: 'https://external.test/contact',
        normalized: { ok: true, url: 'https://external.test/contact' },
        admission: { kind: 'EXTERNAL_RECORD_ONLY', url: 'https://external.test/contact' },
      },
      {
        sourcePageId,
        anchorText: 'Email us',
        ariaLabel: null,
        title: null,
        rawHref: 'mailto:help@example.test',
        normalized: { ok: false, rawUrl: 'mailto:help@example.test', reason: 'unsupported URL scheme' },
        admission: { kind: 'SPECIAL_SCHEME_RECORD_ONLY', rawUrl: 'mailto:help@example.test', scheme: 'mailto' },
      },
      {
        sourcePageId,
        anchorText: 'Invalid target',
        ariaLabel: null,
        title: null,
        rawHref: 'http://[::1',
        normalized: { ok: false, rawUrl: 'http://[::1', reason: 'invalid URL' },
        admission: { kind: 'REJECTED_INVALID', rawUrl: 'http://[::1', reason: 'invalid URL' },
      },
    ]);
    expect(links.filter((link) => link.admission.kind === 'INTERNAL_NAVIGABLE')).toHaveLength(1);
  });

  it('does not let an external document base grant internal admission in the two-argument path', async () => {
    await page.setContent(`
      <base href="https://external.test/subdirectory/">
      <a href="relative-offer">Relative offer</a>
    `);

    const links = await discoverLinks(page, createPageId(4));

    expect(links).toMatchObject([{
      rawHref: 'relative-offer',
      normalized: { ok: true, url: 'https://external.test/subdirectory/relative-offer' },
      admission: { kind: 'EXTERNAL_RECORD_ONLY', url: 'https://external.test/subdirectory/relative-offer' },
    }]);
  });

  it('fails closed to record-only admission when the current page has no HTTP(S) origin', async () => {
    await page.setContent('<a href="https://example.test/offer">Offer</a>');

    const links = await discoverLinks(page, createPageId(5));

    expect(links).toMatchObject([{
      normalized: { ok: true, url: 'https://example.test/offer' },
      admission: { kind: 'EXTERNAL_RECORD_ONLY', url: 'https://example.test/offer' },
    }]);
  });

  it('keeps an internal admission alongside the separately normalized queue URL', async () => {
    await page.setContent(`
      <base href="https://example.test/">
      <a href="/%7eprofile?utm_source=ad#top">Profile</a>
    `);

    const [link] = await discoverLinks(page, createPageId(6), {
      allowedOrigins: new Set(['https://example.test']),
      allowedQueryParameters: new Set(),
    });

    expect(link).toBeDefined();
    if (link !== undefined && link.normalized.ok && link.admission.kind === 'INTERNAL_NAVIGABLE') {
      const candidate: CrawlCandidate = { url: link.normalized.url, depth: 1 };

      expect(link.admission.url).toBe('https://example.test/~profile');
      expect(candidate.url).toBe('https://example.test/~profile');
    }
  });
});
