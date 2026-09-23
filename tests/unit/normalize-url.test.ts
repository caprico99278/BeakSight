import { describe, expect, it } from 'vitest';
import { normalizeUrl } from '../../src/crawl/normalize-url.js';

describe('normalizeUrl', () => {
  it('drops tracking parameters and fragments', () => {
    expect(normalizeUrl(
      '/pricing?utm_source=x&page=2#top',
      'https://example.test/',
      new Set(['page']),
    )).toEqual({ ok: true, url: 'https://example.test/pricing?page=2' });
  });

  it('keeps only allowed query keys in code-unit sorted order', () => {
    expect(normalizeUrl(
      '/search?z=last&utm_campaign=spring&a=first&fbclid=ignored&a=second&gclid=ignored&page=2',
      'https://example.test/',
      new Set(['z', 'a', 'page']),
    )).toEqual({ ok: true, url: 'https://example.test/search?a=first&a=second&page=2&z=last' });
  });

  it('normalizes a default port without collapsing duplicate path slashes', () => {
    expect(normalizeUrl(
      'https://example.test:443/catalog//summer/',
      'https://unused.test/',
      new Set(),
    )).toEqual({ ok: true, url: 'https://example.test/catalog//summer/' });
  });

  it('decodes percent-encoded unreserved path octets into one canonical visited key', () => {
    const allowedQueryParameters = new Set<string>();

    expect(normalizeUrl('/%7eprofile', 'https://example.test/', allowedQueryParameters)).toEqual({
      ok: true,
      url: 'https://example.test/~profile',
    });
    expect(normalizeUrl('/%7Eprofile', 'https://example.test/', allowedQueryParameters)).toEqual({
      ok: true,
      url: 'https://example.test/~profile',
    });
    expect(normalizeUrl('/~profile', 'https://example.test/', allowedQueryParameters)).toEqual({
      ok: true,
      url: 'https://example.test/~profile',
    });
  });

  it('keeps reserved encoded path delimiters escaped with uppercase hexadecimal', () => {
    expect(normalizeUrl('/catalog%2farchive', 'https://example.test/', new Set())).toEqual({
      ok: true,
      url: 'https://example.test/catalog%2Farchive',
    });
  });

  it.each(['mailto:help@example.test', 'tel:+81-3-0000-0000'])('rejects %s as a navigable URL', (rawUrl) => {
    expect(normalizeUrl(rawUrl, 'https://example.test/', new Set())).toEqual({
      ok: false,
      rawUrl,
      reason: 'unsupported URL scheme',
    });
  });
});
