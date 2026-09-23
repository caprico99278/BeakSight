import { describe, expect, it } from 'vitest';
import { classifyUrl } from '../../src/crawl/admission-policy.js';
import { CrawlQueue, type CrawlCandidate } from '../../src/crawl/crawl-queue.js';
import { normalizeUrl } from '../../src/crawl/normalize-url.js';

const normalizedUrl = (path: string) => {
  const normalized = normalizeUrl(`https://example.test${path}`, 'https://unused.test/', new Set());
  if (!normalized.ok) {
    throw new Error('test fixture must be a normalized URL');
  }
  return normalized.url;
};

describe('CrawlQueue', () => {
  it('dequeues accepted candidates in insertion order', () => {
    const queue = new CrawlQueue();
    queue.enqueue({ url: normalizedUrl('/'), depth: 0 });
    queue.enqueue({ url: normalizedUrl('/pricing'), depth: 1 });

    expect(queue.dequeue()).toEqual({ url: 'https://example.test/', depth: 0 });
    expect(queue.dequeue()).toEqual({ url: 'https://example.test/pricing', depth: 1 });
    expect(queue.dequeue()).toBeUndefined();
  });

  it('deduplicates a URL while preserving the depth of its first discovery', () => {
    const queue = new CrawlQueue();
    expect(queue.enqueue({ url: normalizedUrl('/catalog'), depth: 1 })).toBe(true);
    expect(queue.enqueue({ url: normalizedUrl('/catalog'), depth: 4 })).toBe(false);

    expect(queue.dequeue()).toEqual({ url: 'https://example.test/catalog', depth: 1 });
  });

  it('does not re-enqueue a URL after it has been dequeued', () => {
    const queue = new CrawlQueue();
    queue.enqueue({ url: normalizedUrl('/catalog'), depth: 1 });
    queue.dequeue();

    expect(queue.enqueue({ url: normalizedUrl('/catalog'), depth: 2 })).toBe(false);
    expect(queue.dequeue()).toBeUndefined();
  });

  it('snapshots and freezes an accepted candidate so caller mutation cannot change the crawl order data', () => {
    const queue = new CrawlQueue();
    const candidate = { url: normalizedUrl('/catalog'), depth: 1 };

    expect(queue.enqueue(candidate)).toBe(true);
    candidate.depth = 9;

    const dequeued = queue.dequeue();
    expect(dequeued).toEqual({ url: 'https://example.test/catalog', depth: 1 });
    expect(Object.isFrozen(dequeued)).toBe(true);
  });

  it.each([-1, 1.5, Number.POSITIVE_INFINITY])('rejects invalid queue depth %s without consuming the URL', (depth) => {
    const queue = new CrawlQueue();
    const url = normalizedUrl('/catalog');

    expect(queue.enqueue({ url, depth })).toBe(false);
    expect(queue.enqueue({ url, depth: 1 })).toBe(true);
    expect(queue.dequeue()).toEqual({ url: 'https://example.test/catalog', depth: 1 });
  });

  it('does not let direct admission mint a normalized queue URL type', () => {
    const directAdmission = classifyUrl(new URL('https://example.test/%7eprofile?utm_source=ad#top'), {
      allowedOrigins: new Set(['https://example.test']),
    });
    const normalized = normalizeUrl(
      'https://example.test/%7eprofile?utm_source=ad#top',
      'https://unused.test/',
      new Set(),
    );

    expect(directAdmission).toEqual({
      kind: 'INTERNAL_NAVIGABLE',
      url: 'https://example.test/%7eprofile?utm_source=ad#top',
    });
    expect(normalized).toEqual({ ok: true, url: 'https://example.test/~profile' });
    if (directAdmission.kind === 'INTERNAL_NAVIGABLE' && normalized.ok) {
      // @ts-expect-error Direct admission is not canonical normalization authority for queue URLs.
      const unsoundCandidate: CrawlCandidate = { url: directAdmission.url, depth: 1 };
      const canonicalCandidate: CrawlCandidate = { url: normalized.url, depth: 1 };

      expect(unsoundCandidate.url).not.toBe(canonicalCandidate.url);
      expect(canonicalCandidate.url).toBe('https://example.test/~profile');
    }
  });
});
