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

// 中断した Run の再開（`2026-10-01-beaksight-resumable-run-design.md` 4.2、第7章）の R1: 待ち行列の今の中身と、
// 受け付けたことのある URL の一覧の取り出しと、その値からの作り直し。
describe('CrawlQueue snapshot and restore', () => {
  /** `/` を取り出した後に、`/pricing` と `/catalog` が残っている待ち行列。 */
  const partlyConsumedQueue = (): CrawlQueue => {
    const queue = new CrawlQueue();
    queue.enqueue({ url: normalizedUrl('/'), depth: 0 });
    queue.enqueue({ url: normalizedUrl('/pricing'), depth: 1 });
    queue.enqueue({ url: normalizedUrl('/catalog'), depth: 1 });
    queue.dequeue();
    return queue;
  };

  /** 保存のファイルを通したのと同じく、JSON にして読み戻した値。 */
  const throughJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

  it('takes a frozen, JSON-serializable snapshot of the pending candidates in order and of every accepted URL', () => {
    const snapshot = partlyConsumedQueue().snapshot();

    expect(snapshot).toEqual({
      pending: [{ url: 'https://example.test/pricing', depth: 1 }, { url: 'https://example.test/catalog', depth: 1 }],
      seenUrls: ['https://example.test/', 'https://example.test/pricing', 'https://example.test/catalog'],
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.pending)).toBe(true);
    expect(Object.isFrozen(snapshot.seenUrls)).toBe(true);
    expect(snapshot.pending.every((candidate) => Object.isFrozen(candidate))).toBe(true);
    expect(throughJson(snapshot)).toEqual(snapshot);
  });

  it('restores a queue that keeps the FIFO order and deduplicates every URL accepted before the snapshot', () => {
    const restored = CrawlQueue.restore(throughJson(partlyConsumedQueue().snapshot()));

    // 取り出し済みの URL も、待っている URL も、受け付けない。
    expect(restored.enqueue({ url: normalizedUrl('/'), depth: 2 })).toBe(false);
    expect(restored.enqueue({ url: normalizedUrl('/catalog'), depth: 2 })).toBe(false);
    expect(restored.enqueue({ url: normalizedUrl('/support'), depth: 2 })).toBe(true);

    expect(restored.dequeue()).toEqual({ url: 'https://example.test/pricing', depth: 1 });
    expect(restored.dequeue()).toEqual({ url: 'https://example.test/catalog', depth: 1 });
    expect(restored.dequeue()).toEqual({ url: 'https://example.test/support', depth: 2 });
    expect(restored.dequeue()).toBeUndefined();
  });

  it('behaves like the queue it was taken from for the same following operations', () => {
    const original = partlyConsumedQueue();
    const restored = CrawlQueue.restore(throughJson(original.snapshot()));
    const operate = (queue: CrawlQueue) => [
      queue.enqueue({ url: normalizedUrl('/pricing'), depth: 3 }),
      queue.dequeue(),
      queue.enqueue({ url: normalizedUrl('/support'), depth: 2 }),
      queue.enqueue({ url: normalizedUrl('/'), depth: 2 }),
      queue.dequeue(),
      queue.dequeue(),
      queue.dequeue(),
    ];

    expect(operate(restored)).toEqual(operate(original));
    expect(restored.snapshot()).toEqual(original.snapshot());
  });

  it('keeps the snapshot and the restored queue independent of the queue it was taken from', () => {
    const original = partlyConsumedQueue();
    const snapshot = original.snapshot();
    const restored = CrawlQueue.restore(snapshot);

    original.dequeue();
    original.enqueue({ url: normalizedUrl('/support'), depth: 2 });

    expect(snapshot.pending.map((candidate) => candidate.url)).toEqual(['https://example.test/pricing', 'https://example.test/catalog']);
    expect(snapshot.seenUrls).toHaveLength(3);
    expect(restored.snapshot()).toEqual(snapshot);
  });

  it('copies and freezes the restored candidates so mutating the input cannot change the restored queue', () => {
    const pending = [{ url: normalizedUrl('/pricing'), depth: 1 }];
    const seenUrls = [normalizedUrl('/'), normalizedUrl('/pricing')];
    const restored = CrawlQueue.restore({ pending, seenUrls });

    pending[0] = { url: normalizedUrl('/catalog'), depth: 5 };
    seenUrls.pop();

    expect(restored.enqueue({ url: normalizedUrl('/pricing'), depth: 1 })).toBe(false);
    const dequeued = restored.dequeue();
    expect(dequeued).toEqual({ url: 'https://example.test/pricing', depth: 1 });
    expect(Object.isFrozen(dequeued)).toBe(true);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1' as unknown as number])('rejects restoring a pending depth of %s', (depth) => {
    const url = normalizedUrl('/pricing');

    expect(() => CrawlQueue.restore({ pending: [{ url, depth }], seenUrls: [url] })).toThrow(RangeError);
  });

  it('rejects restoring a pending URL that is not in the accepted URLs', () => {
    expect(() => CrawlQueue.restore({
      pending: [{ url: normalizedUrl('/pricing'), depth: 1 }],
      seenUrls: [normalizedUrl('/')],
    })).toThrow(/not.*accepted/u);
  });

  it('rejects restoring the same pending URL twice', () => {
    const url = normalizedUrl('/pricing');

    expect(() => CrawlQueue.restore({ pending: [{ url, depth: 1 }, { url, depth: 2 }], seenUrls: [url] })).toThrow(/twice/u);
  });

  it('rejects restoring the same accepted URL twice', () => {
    const url = normalizedUrl('/pricing');

    expect(() => CrawlQueue.restore({ pending: [], seenUrls: [url, url] })).toThrow(/twice/u);
  });
});
