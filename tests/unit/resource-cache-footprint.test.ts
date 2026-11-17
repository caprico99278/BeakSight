// 資源のキャッシュ（`src/browser/resource-delivery.ts` の `ResourceCache`）の合計の上限に、項目の付属分（URL の鍵と、持つ応答の header）も入れる。
// 要求を出し続ける画面（本文が小さく、URL ごとに別の資源）で、本文の大きさだけを数えていたため、付属分が上限に入らずにメモリが増え続けた件。
// 合計の上限はキャッシュの容量で、網羅を削る上限ではない（入りきらない分は、キャッシュせずに読むだけ）。
import { describe, expect, it } from 'vitest';
import {
  RESOURCE_CACHE_STORABLE_STATUS,
  ResourceCache,
  type ResourceCacheLimits,
  type ResourceCacheStoreFact,
} from '../../src/browser/resource-delivery.js';

const ORIGIN = 'https://example.com';
const LONG_SEGMENT = 'a'.repeat(200);

const fact = (url: string, responseHeaders: Readonly<Record<string, string>> = { 'content-type': 'text/css' }): ResourceCacheStoreFact => ({
  method: 'GET',
  resourceType: 'stylesheet',
  url,
  requestHeaders: { accept: 'text/css' },
  status: RESOURCE_CACHE_STORABLE_STATUS,
  responseHeaders,
  body: new Uint8Array(1).fill(1),
  servedFromRunCache: false,
});

describe('ResourceCache counts the URL key and the kept headers in the total', () => {
  it('keeps no more small entries with long URLs than the total holds with their URL keys', () => {
    const limits: ResourceCacheLimits = Object.freeze({ maxEntryBytes: 4, maxTotalBytes: 2_000 });
    const cache = new ResourceCache({ limits });
    for (let index = 0; index < 100; index += 1) {
      cache.store(fact(`${ORIGIN}/${LONG_SEGMENT}?t=${index}`));
    }

    // 1 件の URL の鍵だけで 200 バイトを超えるので、合計 2,000 バイトには 10 件より少なくしか入らない。
    expect(cache.stats().entryCount).toBeLessThan(10);
    expect(cache.stats().entryCount).toBeGreaterThan(0);
  });

  it('counts the kept response headers in the total', () => {
    const limits: ResourceCacheLimits = Object.freeze({ maxEntryBytes: 4, maxTotalBytes: 2_000 });
    const cache = new ResourceCache({ limits });
    for (let index = 0; index < 100; index += 1) {
      cache.store(fact(`${ORIGIN}/s${index}.css`, { 'content-type': 'text/css', 'x-padding': 'p'.repeat(300) }));
    }

    expect(cache.stats().entryCount).toBeLessThan(7);
  });

  it('does not store an entry whose URL key and headers alone exceed the total, and keeps the other entries', () => {
    const limits: ResourceCacheLimits = Object.freeze({ maxEntryBytes: 4, maxTotalBytes: 500 });
    const cache = new ResourceCache({ limits });
    expect(cache.store(fact(`${ORIGIN}/small.css`))).toBe(true);

    expect(cache.store(fact(`${ORIGIN}/${'b'.repeat(600)}.css`))).toBe(false);
    expect(cache.lookup(`${ORIGIN}/small.css`)).toBeDefined();
    expect(cache.stats().entryCount).toBe(1);
  });
});
