import type { Browser, Page } from 'playwright';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPageId } from '../../src/core/ids.js';
import type { CrawlCandidate } from '../../src/crawl/crawl-queue.js';
import { MAX_URL_LENGTH } from '../../src/core/limits.js';
import {
  LINK_LIMITS,
  discoverLinks,
  type LinkDiscoveryPolicy,
} from '../../src/crawl/discover-links.js';
import { launchHeadlessChromium } from '../helpers/chromium.js';

describe('discoverLinks', () => {
  let browser: Browser | undefined;
  let page: Page;

  beforeEach(async () => {
    browser = await launchHeadlessChromium();
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
    const { links } = await discoverLinks(page, sourcePageId, {
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
        truncated: false,
      },
      {
        sourcePageId,
        anchorText: 'External contact',
        ariaLabel: null,
        title: null,
        rawHref: 'https://external.test/contact',
        normalized: { ok: true, url: 'https://external.test/contact' },
        admission: { kind: 'EXTERNAL_RECORD_ONLY', url: 'https://external.test/contact' },
        truncated: false,
      },
      {
        sourcePageId,
        anchorText: 'Email us',
        ariaLabel: null,
        title: null,
        rawHref: 'mailto:help@example.test',
        normalized: { ok: false, rawUrl: 'mailto:help@example.test', reason: 'UNSUPPORTED_SCHEME' },
        admission: { kind: 'SPECIAL_SCHEME_RECORD_ONLY', rawUrl: 'mailto:help@example.test', scheme: 'mailto' },
        truncated: false,
      },
      {
        sourcePageId,
        anchorText: 'Invalid target',
        ariaLabel: null,
        title: null,
        rawHref: 'http://[::1',
        normalized: { ok: false, rawUrl: 'http://[::1', reason: 'INVALID_URL' },
        admission: { kind: 'REJECTED_INVALID', rawUrl: 'http://[::1', reason: 'INVALID_URL' },
        truncated: false,
      },
    ]);
    expect(links.filter((link) => link.admission.kind === 'INTERNAL_NAVIGABLE')).toHaveLength(1);
  });

  it('requires an explicit link discovery policy', async () => {
    await page.setContent('<a href="https://example.test/offer">Offer</a>');

    // @ts-expect-error `policy` は必須の引数である（暗黙の受け入れ判定を持たない）。
    await expect(discoverLinks(page, createPageId(4))).rejects.toThrow(TypeError);
    await expect(discoverLinks(page, createPageId(4), undefined as unknown as LinkDiscoveryPolicy)).rejects.toThrow(TypeError);
  });

  it('does not let an external document base grant internal admission', async () => {
    await page.setContent(`
      <base href="https://external.test/subdirectory/">
      <a href="relative-offer">Relative offer</a>
    `);

    const { links } = await discoverLinks(page, createPageId(4), {
      allowedOrigins: new Set(['https://example.test']),
      allowedQueryParameters: new Set(),
    });

    expect(links).toMatchObject([{
      rawHref: 'relative-offer',
      normalized: { ok: true, url: 'https://external.test/subdirectory/relative-offer' },
      admission: { kind: 'EXTERNAL_RECORD_ONLY', url: 'https://external.test/subdirectory/relative-offer' },
    }]);
  });

  it('fails closed to record-only admission when the policy allows no origin', async () => {
    await page.setContent('<a href="https://example.test/offer">Offer</a>');

    const { links } = await discoverLinks(page, createPageId(5), {
      allowedOrigins: new Set(),
      allowedQueryParameters: new Set(),
    });

    expect(links).toMatchObject([{
      normalized: { ok: true, url: 'https://example.test/offer' },
      admission: { kind: 'EXTERNAL_RECORD_ONLY', url: 'https://example.test/offer' },
    }]);
  });

  it('rejects credential-bearing hrefs and redacts the credentials from every recorded field', async () => {
    await page.setContent(`
      <base href="https://example.test/current/">
      <a href="https://user:secret@example.test/private">Absolute credentials</a>
      <a href="//user:secret@example.test/scheme-relative">Scheme-relative credentials</a>
      <a href="ftp://user:secret@example.test/file">FTP credentials</a>
      <a href="http://user:secret@bad host/">Invalid host with credentials</a>
    `);
    const sourcePageId = createPageId(7);

    const { links } = await discoverLinks(page, sourcePageId, {
      allowedOrigins: new Set(['https://example.test']),
      allowedQueryParameters: new Set(),
    });

    expect(links).toEqual([
      {
        sourcePageId,
        anchorText: 'Absolute credentials',
        ariaLabel: null,
        title: null,
        rawHref: 'https://[REDACTED]@example.test/private',
        normalized: { ok: false, rawUrl: 'https://[REDACTED]@example.test/private', reason: 'CREDENTIALS_NOT_ALLOWED' },
        admission: { kind: 'REJECTED_INVALID', rawUrl: 'https://[REDACTED]@example.test/private', reason: 'CREDENTIALS_NOT_ALLOWED' },
        truncated: false,
      },
      {
        sourcePageId,
        anchorText: 'Scheme-relative credentials',
        ariaLabel: null,
        title: null,
        rawHref: '//[REDACTED]@example.test/scheme-relative',
        normalized: { ok: false, rawUrl: '//[REDACTED]@example.test/scheme-relative', reason: 'CREDENTIALS_NOT_ALLOWED' },
        admission: { kind: 'REJECTED_INVALID', rawUrl: '//[REDACTED]@example.test/scheme-relative', reason: 'CREDENTIALS_NOT_ALLOWED' },
        truncated: false,
      },
      {
        sourcePageId,
        anchorText: 'FTP credentials',
        ariaLabel: null,
        title: null,
        rawHref: 'ftp://[REDACTED]@example.test/file',
        normalized: { ok: false, rawUrl: 'ftp://[REDACTED]@example.test/file', reason: 'UNSUPPORTED_SCHEME' },
        admission: { kind: 'SPECIAL_SCHEME_RECORD_ONLY', rawUrl: 'ftp://[REDACTED]@example.test/file', scheme: 'ftp' },
        truncated: false,
      },
      {
        sourcePageId,
        anchorText: 'Invalid host with credentials',
        ariaLabel: null,
        title: null,
        rawHref: 'http://[REDACTED]@bad host/',
        normalized: { ok: false, rawUrl: 'http://[REDACTED]@bad host/', reason: 'INVALID_URL' },
        admission: { kind: 'REJECTED_INVALID', rawUrl: 'http://[REDACTED]@bad host/', reason: 'INVALID_URL' },
        truncated: false,
      },
    ]);
    expect(JSON.stringify(links)).not.toContain('secret');
  });

  it('keeps an internal admission alongside the separately normalized queue URL', async () => {
    await page.setContent(`
      <base href="https://example.test/">
      <a href="/%7eprofile?utm_source=ad#top">Profile</a>
    `);

    const { links: [link] } = await discoverLinks(page, createPageId(6), {
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

  describe('M4: bounded Link Evidence', () => {
    const policy: LinkDiscoveryPolicy = {
      allowedOrigins: new Set(['https://example.test']),
      allowedQueryParameters: new Set(),
    };

    it('records at most LINK_LIMITS.maxLinks links in document order and counts the omitted ones', async () => {
      const total = LINK_LIMITS.maxLinks + 3;
      const anchors = Array.from({ length: total }, (_value, index) => `<a href="/item-${index}">Item ${index}</a>`);
      await page.setContent(`<base href="https://example.test/">${anchors.join('')}`);

      const evidence = await discoverLinks(page, createPageId(9), policy);

      expect(evidence.links).toHaveLength(LINK_LIMITS.maxLinks);
      expect(evidence.omittedLinkCount).toBe(3);
      expect(evidence.links[0]).toMatchObject({ anchorText: 'Item 0', rawHref: '/item-0' });
      expect(evidence.links.at(-1)).toMatchObject({
        anchorText: `Item ${LINK_LIMITS.maxLinks - 1}`,
        rawHref: `/item-${LINK_LIMITS.maxLinks - 1}`,
      });
      // 入口は discoverLinks() の1つだけで、link の Evidence の payload（links と omittedLinkCount）を返す（F08 の項目7）。
      expect(Object.keys(evidence).sort()).toEqual(['links', 'omittedLinkCount']);
    });

    it('reports no omitted link when the page is within the count limit', async () => {
      await page.setContent('<base href="https://example.test/"><a href="/one">One</a><a href="/two">Two</a>');

      const evidence = await discoverLinks(page, createPageId(10), policy);

      expect(evidence.links).toHaveLength(2);
      expect(evidence.omittedLinkCount).toBe(0);
    });

    it('truncates anchorText, ariaLabel, and title to LINK_LIMITS.maxTextLength and marks the link', async () => {
      const long = 'x'.repeat(LINK_LIMITS.maxTextLength + 10);
      await page.setContent(`
        <base href="https://example.test/">
        <a href="/text">${long}</a>
        <a href="/label" aria-label="${long}">Label</a>
        <a href="/title" title="${long}">Title</a>
        <a href="/short" aria-label="Short" title="Short">Short</a>
      `);

      const { links } = await discoverLinks(page, createPageId(11), policy);
      const bounded = 'x'.repeat(LINK_LIMITS.maxTextLength);

      expect(links).toMatchObject([
        { anchorText: bounded, truncated: true },
        { ariaLabel: bounded, anchorText: 'Label', truncated: true },
        { title: bounded, anchorText: 'Title', truncated: true },
        { ariaLabel: 'Short', title: 'Short', anchorText: 'Short', truncated: false },
      ]);
    });

    it('bounds a long href to MAX_URL_LENGTH and does not accept it for the crawl queue', async () => {
      const href = `/${'a'.repeat(MAX_URL_LENGTH + 10)}`;
      await page.setContent(`<base href="https://example.test/"><a href="${href}">Long</a>`);

      const { links: [link] } = await discoverLinks(page, createPageId(12), policy);

      expect(link).toEqual({
        sourcePageId: createPageId(12),
        anchorText: 'Long',
        ariaLabel: null,
        title: null,
        rawHref: href.slice(0, MAX_URL_LENGTH),
        normalized: { ok: false, rawUrl: href.slice(0, MAX_URL_LENGTH), reason: 'URL_TOO_LONG' },
        admission: { kind: 'REJECTED_INVALID', rawUrl: href.slice(0, MAX_URL_LENGTH), reason: 'URL_TOO_LONG' },
        truncated: true,
      });
    });

    it('bounds the raw URL of a long special-scheme href', async () => {
      const href = `mailto:${'m'.repeat(MAX_URL_LENGTH + 10)}@example.test`;
      await page.setContent(`<a href="${href}">Mail</a>`);

      const { links: [link] } = await discoverLinks(page, createPageId(13), policy);

      expect(link).toMatchObject({
        rawHref: href.slice(0, MAX_URL_LENGTH),
        normalized: { ok: false, rawUrl: href.slice(0, MAX_URL_LENGTH), reason: 'UNSUPPORTED_SCHEME' },
        admission: { kind: 'SPECIAL_SCHEME_RECORD_ONLY', rawUrl: href.slice(0, MAX_URL_LENGTH), scheme: 'mailto' },
        truncated: true,
      });
    });

    it('redacts the credentials of a long href before truncating it', async () => {
      const href = `https://user:secret@example.test/${'a'.repeat(MAX_URL_LENGTH)}`;
      await page.setContent(`<a href="${href}">Long credentials</a>`);

      const { links: [link] } = await discoverLinks(page, createPageId(14), policy);

      expect(link?.rawHref.startsWith('https://[REDACTED]@example.test/')).toBe(true);
      expect(link).toMatchObject({
        normalized: { ok: false, reason: 'CREDENTIALS_NOT_ALLOWED' },
        admission: { kind: 'REJECTED_INVALID', reason: 'CREDENTIALS_NOT_ALLOWED' },
        truncated: true,
      });
      expect(JSON.stringify(link)).not.toContain('secret');
    });

    it('keeps every recorded string within its limit', async () => {
      const long = 'y'.repeat(LINK_LIMITS.maxTextLength * 2);
      const longPath = 'p'.repeat(MAX_URL_LENGTH * 2);
      await page.setContent(`
        <base href="https://example.test/">
        <a href="/${longPath}" aria-label="${long}" title="${long}">${long}</a>
        <a href="ftp://${longPath}">${long}</a>
        <a href="${longPath}:rest">${long}</a>
      `);

      const { links } = await discoverLinks(page, createPageId(15), policy);

      expect(links).toHaveLength(3);
      for (const link of links) {
        expect(link.truncated).toBe(true);
        expect(link.anchorText.length).toBeLessThanOrEqual(LINK_LIMITS.maxTextLength);
        expect(link.ariaLabel?.length ?? 0).toBeLessThanOrEqual(LINK_LIMITS.maxTextLength);
        expect(link.title?.length ?? 0).toBeLessThanOrEqual(LINK_LIMITS.maxTextLength);
        const urlFields = [
          link.rawHref,
          link.normalized.ok ? link.normalized.url : link.normalized.rawUrl,
          'url' in link.admission ? link.admission.url : link.admission.rawUrl,
          link.admission.kind === 'SPECIAL_SCHEME_RECORD_ONLY' ? link.admission.scheme : '',
        ];
        for (const value of urlFields) {
          expect(value.length).toBeLessThanOrEqual(MAX_URL_LENGTH);
        }
      }
    });
  });
});
