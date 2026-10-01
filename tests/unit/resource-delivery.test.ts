import { describe, expect, it } from 'vitest';
import {
  RESOURCE_CACHE_LIMITS,
  RESOURCE_CACHE_RESOURCE_TYPES,
  RESOURCE_CACHE_STORABLE_STATUS,
  RESOURCE_DELIVERY_ROLES,
  ResourceCache,
  decideResourceDelivery,
  type ResourceCacheLimits,
  type ResourceCacheResponseFact,
  type ResourceCacheStoreFact,
  type ResourceDeliveryRequestFacts,
  type ResourceDeliveryRole,
} from '../../src/browser/resource-delivery.js';

const ALLOWED_ORIGIN = 'https://example.com';
const OTHER_ORIGIN = 'https://example.net';
const STYLE_URL = `${ALLOWED_ORIGIN}/assets/site.css`;
const OTHER_SCRIPT_URL = `${OTHER_ORIGIN}/tag.js`;

/** 小さい上限（LRU をテストで確かめるため）。 */
const SMALL_LIMITS: ResourceCacheLimits = Object.freeze({ maxEntryBytes: 4, maxTotalBytes: 10 });

const bytes = (length: number, fill = 1): Uint8Array => new Uint8Array(length).fill(fill);

/** 入れる条件をすべて満たす応答の事実。 */
const storableFact = (overrides: Partial<ResourceCacheStoreFact> = {}): ResourceCacheStoreFact => ({
  method: 'GET',
  resourceType: 'stylesheet',
  url: STYLE_URL,
  requestHeaders: { accept: 'text/css' },
  status: RESOURCE_CACHE_STORABLE_STATUS,
  responseHeaders: { 'content-type': 'text/css' },
  body: bytes(3),
  servedFromRunCache: false,
  ...overrides,
});

const cachedUrls = (cache: ResourceCache, urls: readonly string[]): readonly string[] =>
  urls.filter((url) => cache.lookup(url) !== undefined);

describe('ResourceCache の入れる条件', () => {
  it('入れる条件をすべて満たす応答を入れ、引くと同じ URL・status・本文を返す', () => {
    const cache = new ResourceCache();
    const body = bytes(3, 7);

    expect(cache.store(storableFact({ body }))).toBe(true);

    const resource = cache.lookup(STYLE_URL);
    expect(resource?.url).toBe(STYLE_URL);
    expect(resource?.status).toBe(RESOURCE_CACHE_STORABLE_STATUS);
    expect(resource?.body).toEqual(body);
    expect(cache.stats()).toEqual({ entryCount: 1, totalBytes: body.byteLength });
  });

  it('Buffer の本文も入れられる', () => {
    const cache = new ResourceCache();
    const body = Buffer.from('body{}');

    expect(cache.store(storableFact({ body }))).toBe(true);
    expect(new TextDecoder().decode(cache.lookup(STYLE_URL)?.body)).toBe('body{}');
  });

  it.each(['GET', 'get', 'GeT'])('method %s は、大文字小文字を区別せず GET として入れる', (method) => {
    const cache = new ResourceCache();
    expect(cache.store(storableFact({ method }))).toBe(true);
  });

  it.each(['HEAD', 'POST', 'OPTIONS', ''])('method %s は入れない', (method) => {
    const cache = new ResourceCache();
    expect(cache.store(storableFact({ method }))).toBe(false);
    expect(cache.lookup(STYLE_URL)).toBeUndefined();
  });

  it.each([...RESOURCE_CACHE_RESOURCE_TYPES])('要求の種類 %s は入れる', (resourceType) => {
    const cache = new ResourceCache();
    expect(cache.store(storableFact({ resourceType }))).toBe(true);
  });

  it.each(['document', 'xhr', 'fetch', 'media', 'websocket', 'manifest', 'other', 'Stylesheet', ''])(
    '要求の種類 %s は入れない',
    (resourceType) => {
      const cache = new ResourceCache();
      expect(cache.store(storableFact({ resourceType }))).toBe(false);
      expect(cache.stats().entryCount).toBe(0);
    },
  );

  it.each([201, 204, 206, 301, 304, 404, 500])('status %s は入れない', (status) => {
    const cache = new ResourceCache();
    expect(cache.store(storableFact({ status }))).toBe(false);
  });

  it.each([{ range: 'bytes=0-10' }, { Range: 'bytes=0-' }, { RANGE: 'bytes=5-' }])(
    '要求に range の header（名前の大文字小文字を問わない）があれば入れない: %o',
    (requestHeaders) => {
      const cache = new ResourceCache();
      expect(cache.store(storableFact({ requestHeaders }))).toBe(false);
    },
  );

  it.each([
    { 'cache-control': 'no-store' },
    { 'Cache-Control': 'No-Store' },
    { 'CACHE-CONTROL': 'private, NO-STORE, max-age=0' },
    { 'cache-control': 'public,no-store' },
  ])('応答の cache-control に no-store（大文字小文字を問わない）があれば入れない: %o', (responseHeaders) => {
    const cache = new ResourceCache();
    expect(cache.store(storableFact({ responseHeaders }))).toBe(false);
  });

  it.each([
    { 'cache-control': 'no-cache' },
    { 'cache-control': 'private, max-age=0, must-revalidate' },
    { 'cache-control': '' },
    {},
  ])('no-store でない cache-control なら入れる: %o', (responseHeaders) => {
    const cache = new ResourceCache();
    expect(cache.store(storableFact({ responseHeaders }))).toBe(true);
  });

  it('本文が1件の上限ちょうどなら入れ、1バイトでも超えれば入れない', () => {
    const cache = new ResourceCache();
    const atLimitUrl = `${ALLOWED_ORIGIN}/at-limit.png`;
    const overLimitUrl = `${ALLOWED_ORIGIN}/over-limit.png`;

    expect(cache.store(storableFact({
      url: atLimitUrl,
      resourceType: 'image',
      body: bytes(RESOURCE_CACHE_LIMITS.maxEntryBytes),
    }))).toBe(true);
    expect(cache.store(storableFact({
      url: overLimitUrl,
      resourceType: 'image',
      body: bytes(RESOURCE_CACHE_LIMITS.maxEntryBytes + 1),
    }))).toBe(false);
    expect(cachedUrls(cache, [atLimitUrl, overLimitUrl])).toEqual([atLimitUrl]);
  });

  it('渡した上限（テスト用）の1件の上限を使う', () => {
    const cache = new ResourceCache({ limits: SMALL_LIMITS });
    expect(cache.store(storableFact({ body: bytes(SMALL_LIMITS.maxEntryBytes + 1) }))).toBe(false);
    expect(cache.store(storableFact({ body: bytes(SMALL_LIMITS.maxEntryBytes) }))).toBe(true);
  });

  it('キャッシュから返した応答は入れ直さない（すでにある項目も変えない）', () => {
    const cache = new ResourceCache();
    expect(cache.store(storableFact({ servedFromRunCache: true }))).toBe(false);
    expect(cache.stats().entryCount).toBe(0);

    const original = bytes(2, 1);
    expect(cache.store(storableFact({ body: original }))).toBe(true);
    expect(cache.store(storableFact({ body: bytes(3, 9), servedFromRunCache: true }))).toBe(false);
    expect(cache.lookup(STYLE_URL)?.body).toEqual(original);
  });

  it('入れる条件を満たさない応答は、同じ URL のすでにある項目を変えない', () => {
    const cache = new ResourceCache();
    const original = bytes(2, 1);
    expect(cache.store(storableFact({ body: original }))).toBe(true);

    expect(cache.store(storableFact({ status: 404, body: bytes(3, 9) }))).toBe(false);
    expect(cache.lookup(STYLE_URL)?.body).toEqual(original);
    expect(cache.stats()).toEqual({ entryCount: 1, totalBytes: original.byteLength });
  });
});

describe('ResourceCache の持つ header', () => {
  it('content-encoding・content-length・transfer-encoding・set-cookie を除き、名前を小文字にそろえる', () => {
    const cache = new ResourceCache();
    cache.store(storableFact({
      responseHeaders: {
        'Content-Type': 'text/css; charset=utf-8',
        'Content-Encoding': 'gzip',
        'CONTENT-LENGTH': '3',
        'Transfer-Encoding': 'chunked',
        'Set-Cookie': 'session=secret',
        'Cache-Control': 'max-age=60',
        ETag: '"v1"',
      },
    }));

    expect(cache.lookup(STYLE_URL)?.headers).toEqual({
      'content-type': 'text/css; charset=utf-8',
      'cache-control': 'max-age=60',
      etag: '"v1"',
    });
  });

  it('小文字にそろえて同じ名前になる header は、HTTP の規則どおり「, 」でつなぐ', () => {
    const cache = new ResourceCache();
    cache.store(storableFact({ responseHeaders: { Vary: 'Accept', vary: 'Origin' } }));

    expect(cache.lookup(STYLE_URL)?.headers).toEqual({ vary: 'Accept, Origin' });
  });

  it('引いた項目と、その header は凍結されている', () => {
    const cache = new ResourceCache();
    cache.store(storableFact());
    const resource = cache.lookup(STYLE_URL);

    expect(Object.isFrozen(resource)).toBe(true);
    expect(Object.isFrozen(resource?.headers)).toBe(true);
  });
});

describe('ResourceCache の LRU と入れ直し', () => {
  const urlA = `${ALLOWED_ORIGIN}/a.css`;
  const urlB = `${ALLOWED_ORIGIN}/b.css`;
  const urlC = `${ALLOWED_ORIGIN}/c.css`;
  const urlD = `${ALLOWED_ORIGIN}/d.css`;
  const fullEntry = bytes(SMALL_LIMITS.maxEntryBytes);

  it('合計の上限を超えると、最も前に入れたものから捨てる', () => {
    const cache = new ResourceCache({ limits: SMALL_LIMITS });
    cache.store(storableFact({ url: urlA, body: fullEntry }));
    cache.store(storableFact({ url: urlB, body: fullEntry }));
    cache.store(storableFact({ url: urlC, body: fullEntry }));

    expect(cache.stats()).toEqual({ entryCount: 2, totalBytes: 2 * fullEntry.byteLength });
    expect(cachedUrls(cache, [urlA, urlB, urlC])).toEqual([urlB, urlC]);
  });

  it('lookup で引いたものは最も新しく使われたものになり、捨てられる順が後になる', () => {
    const cache = new ResourceCache({ limits: SMALL_LIMITS });
    cache.store(storableFact({ url: urlA, body: fullEntry }));
    cache.store(storableFact({ url: urlB, body: fullEntry }));
    expect(cache.lookup(urlA)).toBeDefined();

    cache.store(storableFact({ url: urlC, body: fullEntry }));

    expect(cachedUrls(cache, [urlA, urlB, urlC])).toEqual([urlA, urlC]);
  });

  it('合計の上限に収まるまで、前に使われたものから続けて捨てる', () => {
    const limits: ResourceCacheLimits = Object.freeze({ maxEntryBytes: 10, maxTotalBytes: 10 });
    const cache = new ResourceCache({ limits });
    cache.store(storableFact({ url: urlA, body: bytes(3) }));
    cache.store(storableFact({ url: urlB, body: bytes(3) }));
    cache.store(storableFact({ url: urlC, body: bytes(3) }));

    cache.store(storableFact({ url: urlD, body: bytes(limits.maxTotalBytes) }));

    expect(cachedUrls(cache, [urlA, urlB, urlC, urlD])).toEqual([urlD]);
    expect(cache.stats()).toEqual({ entryCount: 1, totalBytes: limits.maxTotalBytes });
  });

  it('同じ URL を入れ直すと、新しい内容で置き換え、合計の大きさと LRU の順を更新する', () => {
    const cache = new ResourceCache({ limits: SMALL_LIMITS });
    cache.store(storableFact({ url: urlA, body: bytes(2, 1), responseHeaders: { etag: '"v1"' } }));
    cache.store(storableFact({ url: urlB, body: fullEntry }));

    const replacement = bytes(SMALL_LIMITS.maxEntryBytes, 2);
    expect(cache.store(storableFact({ url: urlA, body: replacement, responseHeaders: { etag: '"v2"' } }))).toBe(true);
    expect(cache.stats()).toEqual({ entryCount: 2, totalBytes: replacement.byteLength + fullEntry.byteLength });

    // A は入れ直しで最も新しく使われたものになったので、次に捨てられるのは B。
    cache.store(storableFact({ url: urlC, body: fullEntry }));
    expect(cachedUrls(cache, [urlA, urlB, urlC])).toEqual([urlA, urlC]);
    const resource = cache.lookup(urlA);
    expect(resource?.body).toEqual(replacement);
    expect(resource?.headers).toEqual({ etag: '"v2"' });
  });

  it('URL は完全一致で引く', () => {
    const cache = new ResourceCache();
    cache.store(storableFact({ url: urlA }));

    expect(cache.lookup(`${urlA}?v=2`)).toBeUndefined();
    expect(cache.lookup(`${urlA}#x`)).toBeUndefined();
    expect(cache.lookup(urlA.toUpperCase())).toBeUndefined();
  });

  it.each([
    { maxEntryBytes: 0, maxTotalBytes: 10 },
    { maxEntryBytes: 4, maxTotalBytes: 0 },
    { maxEntryBytes: -1, maxTotalBytes: 10 },
    { maxEntryBytes: 1.5, maxTotalBytes: 10 },
    { maxEntryBytes: 4, maxTotalBytes: Number.POSITIVE_INFINITY },
    { maxEntryBytes: 11, maxTotalBytes: 10 },
  ])('不正な上限 %o は受け付けない', (limits) => {
    expect(() => new ResourceCache({ limits })).toThrow();
  });

  it('既定の上限の定数は凍結されている', () => {
    expect(Object.isFrozen(RESOURCE_CACHE_LIMITS)).toBe(true);
    expect(Object.isFrozen(RESOURCE_CACHE_RESOURCE_TYPES)).toBe(true);
    expect(Object.isFrozen(RESOURCE_DELIVERY_ROLES)).toBe(true);
    expect(RESOURCE_CACHE_LIMITS.maxEntryBytes).toBeLessThanOrEqual(RESOURCE_CACHE_LIMITS.maxTotalBytes);
  });
});

// L5b-fix-round-1（サイトへの負荷の制御の設計書 4.6）: 本文を読む前に、キャッシュに入れる見込みがあるかを答える口（`mayStore`）。
// 条件は、入れる条件（`store`）の、本文の大きさ以外と同じである。応答の `content-length` が、そのキャッシュの1件の上限を超えると
// 分かる場合も、見込みなしにする。`store` も、この口で判断する（判断は1か所）。
describe('ResourceCache.mayStore（本文を読む前の見込み）', () => {
  /** 本文を除いた、入れる見込みのある応答の事実。 */
  const responseFact = (overrides: Partial<ResourceCacheResponseFact> = {}): ResourceCacheResponseFact => {
    const { body: _body, ...fact } = storableFact();
    return { ...fact, ...overrides };
  };

  it('入れる条件（本文の大きさ以外）をすべて満たす応答は、見込みあり（本文を読まずに答え、キャッシュを変えない）', () => {
    const cache = new ResourceCache();

    expect(cache.mayStore(responseFact())).toBe(true);
    expect(cache.stats()).toEqual({ entryCount: 0, totalBytes: 0 });
  });

  it.each(['document', 'xhr', 'fetch', 'media', 'other'])('要求の種類 %s は、見込みなし', (resourceType) => {
    expect(new ResourceCache().mayStore(responseFact({ resourceType }))).toBe(false);
  });

  it.each(['HEAD', 'POST', ''])('method %s は、見込みなし', (method) => {
    expect(new ResourceCache().mayStore(responseFact({ method }))).toBe(false);
  });

  it.each([206, 302, 304, 404])('status %s は、見込みなし', (status) => {
    expect(new ResourceCache().mayStore(responseFact({ status }))).toBe(false);
  });

  it('要求に range の header があれば、見込みなし', () => {
    expect(new ResourceCache().mayStore(responseFact({ requestHeaders: { Range: 'bytes=0-' } }))).toBe(false);
  });

  it('応答の cache-control に no-store があれば、見込みなし', () => {
    expect(new ResourceCache().mayStore(responseFact({ responseHeaders: { 'Cache-Control': 'private, no-store' } }))).toBe(false);
  });

  it('キャッシュから返した応答は、見込みなし', () => {
    expect(new ResourceCache().mayStore(responseFact({ servedFromRunCache: true }))).toBe(false);
  });

  it('content-length が1件の上限を超えれば見込みなし。ちょうど上限なら見込みあり。なければ（大きさが分からなければ）見込みあり', () => {
    const cache = new ResourceCache();
    const withLength = (value: string): ResourceCacheResponseFact =>
      responseFact({ responseHeaders: { 'content-type': 'text/css', 'Content-Length': value } });

    expect(cache.mayStore(withLength(String(RESOURCE_CACHE_LIMITS.maxEntryBytes + 1)))).toBe(false);
    expect(cache.mayStore(withLength(String(RESOURCE_CACHE_LIMITS.maxEntryBytes)))).toBe(true);
    expect(cache.mayStore(responseFact({ responseHeaders: { 'content-type': 'text/css' } }))).toBe(true);
    // 10進の整数として読めない値は、大きさが分からないものとして扱う（本文を読んでから、大きさで決める）。
    for (const unreadable of ['', 'abc', '-1', '1.5', '0x10']) {
      expect(cache.mayStore(withLength(unreadable)), unreadable).toBe(true);
    }
  });

  it('content-length の判断は、そのキャッシュ自身の1件の上限で行う', () => {
    const small = new ResourceCache({ limits: SMALL_LIMITS });
    const fact = (value: number): ResourceCacheResponseFact =>
      responseFact({ responseHeaders: { 'content-length': String(value) } });

    expect(small.mayStore(fact(SMALL_LIMITS.maxEntryBytes + 1))).toBe(false);
    expect(small.mayStore(fact(SMALL_LIMITS.maxEntryBytes))).toBe(true);
    // 既定の上限のキャッシュでは、同じ大きさは見込みあり。
    expect(new ResourceCache().mayStore(fact(SMALL_LIMITS.maxEntryBytes + 1))).toBe(true);
  });

  it('store も同じ判断を使う: content-length が上限を超えると分かる応答は、本文が小さくても入れない', () => {
    const small = new ResourceCache({ limits: SMALL_LIMITS });

    expect(small.store(storableFact({
      responseHeaders: { 'content-length': String(SMALL_LIMITS.maxEntryBytes + 1) },
      body: bytes(SMALL_LIMITS.maxEntryBytes),
    }))).toBe(false);
    expect(small.stats().entryCount).toBe(0);
  });
});

describe('decideResourceDelivery', () => {
  const allowedOrigins: ReadonlySet<string> = new Set([ALLOWED_ORIGIN]);
  const allowedImageUrl = `${ALLOWED_ORIGIN}/images/hero.png`;
  const otherImageUrl = `${OTHER_ORIGIN}/pixel.png`;

  const request = (overrides: Partial<ResourceDeliveryRequestFacts> = {}): ResourceDeliveryRequestFacts => ({
    method: 'GET',
    resourceType: 'image',
    url: allowedImageUrl,
    isNavigationRequest: false,
    ...overrides,
  });

  /** 許可 Origin の中の画像と、許可 Origin の外のスクリプトを入れたキャッシュ。 */
  const filledCache = (): ResourceCache => {
    const cache = new ResourceCache();
    cache.store(storableFact({ url: allowedImageUrl, resourceType: 'image' }));
    cache.store(storableFact({ url: OTHER_SCRIPT_URL, resourceType: 'script' }));
    return cache;
  };

  const decide = (
    role: ResourceDeliveryRole,
    facts: ResourceDeliveryRequestFacts,
    cache: ResourceCache = filledCache(),
    origins: ReadonlySet<string> = allowedOrigins,
  ) => decideResourceDelivery({ role, cache, allowedOrigins: origins, request: facts });

  it('Context の役割は PRIMARY と REVISIT の閉じた一覧である', () => {
    expect([...RESOURCE_DELIVERY_ROLES]).toEqual(['PRIMARY', 'REVISIT']);
  });

  it.each([
    request(),
    request({ url: OTHER_SCRIPT_URL, resourceType: 'script' }),
    request({ url: otherImageUrl }),
    request({ isNavigationRequest: true, resourceType: 'document' }),
    request({ url: 'not a url' }),
  ])('PRIMARY の役割では、キャッシュや Origin によらず常に NETWORK: %o', (facts) => {
    expect(decide('PRIMARY', facts)).toEqual({ kind: 'NETWORK' });
  });

  it('PRIMARY の役割では、キャッシュを引かない（LRU の順を変えない）', () => {
    const limits: ResourceCacheLimits = Object.freeze({ maxEntryBytes: 4, maxTotalBytes: 8 });
    const cache = new ResourceCache({ limits });
    const urlA = `${ALLOWED_ORIGIN}/a.png`;
    const urlB = `${ALLOWED_ORIGIN}/b.png`;
    const urlC = `${ALLOWED_ORIGIN}/c.png`;
    cache.store(storableFact({ url: urlA, resourceType: 'image', body: bytes(limits.maxEntryBytes) }));
    cache.store(storableFact({ url: urlB, resourceType: 'image', body: bytes(limits.maxEntryBytes) }));

    decide('PRIMARY', request({ url: urlA }), cache);
    cache.store(storableFact({ url: urlC, resourceType: 'image', body: bytes(limits.maxEntryBytes) }));

    expect(cachedUrls(cache, [urlA, urlB, urlC])).toEqual([urlB, urlC]);
  });

  it.each([
    request({ isNavigationRequest: true }),
    request({ isNavigationRequest: true, resourceType: 'document' }),
    request({ isNavigationRequest: true, resourceType: 'document', url: `${OTHER_ORIGIN}/embed` }),
    request({ isNavigationRequest: true, url: OTHER_SCRIPT_URL, resourceType: 'script' }),
  ])('REVISIT の役割でも、ナビゲーションの要求は、キャッシュや Origin によらず NETWORK: %o', (facts) => {
    expect(decide('REVISIT', facts)).toEqual({ kind: 'NETWORK' });
  });

  it('REVISIT の役割で、GET・キャッシュの種類・キャッシュにある要求は FROM_RUN_CACHE で、キャッシュの内容を持つ', () => {
    const cache = filledCache();
    const expected = cache.lookup(allowedImageUrl);

    expect(decide('REVISIT', request(), cache)).toEqual({ kind: 'FROM_RUN_CACHE', resource: expected });
    expect(decide('REVISIT', request({ method: 'get' }), cache)).toEqual({ kind: 'FROM_RUN_CACHE', resource: expected });
  });

  it('REVISIT の役割で、許可 Origin の外でもキャッシュにあれば FROM_RUN_CACHE', () => {
    const cache = filledCache();

    expect(decide('REVISIT', request({ url: OTHER_SCRIPT_URL, resourceType: 'script' }), cache)).toEqual({
      kind: 'FROM_RUN_CACHE',
      resource: cache.lookup(OTHER_SCRIPT_URL),
    });
  });

  it('REVISIT の役割で、許可 Origin の外で、キャッシュにない要求は WITHHOLD', () => {
    expect(decide('REVISIT', request({ url: otherImageUrl }))).toEqual({ kind: 'WITHHOLD' });
    expect(decide('REVISIT', request({ url: `${OTHER_ORIGIN}/collect`, resourceType: 'fetch' }))).toEqual({ kind: 'WITHHOLD' });
  });

  it('REVISIT の役割で、許可 Origin の中で、キャッシュにない要求は NETWORK', () => {
    expect(decide('REVISIT', request({ url: `${ALLOWED_ORIGIN}/images/other.png` }))).toEqual({ kind: 'NETWORK' });
    expect(decide('REVISIT', request({ url: `${ALLOWED_ORIGIN}/api/items`, resourceType: 'xhr' }))).toEqual({ kind: 'NETWORK' });
  });

  it('GET 以外は、キャッシュにあっても FROM_RUN_CACHE にならない', () => {
    expect(decide('REVISIT', request({ method: 'HEAD' }))).toEqual({ kind: 'NETWORK' });
    expect(decide('REVISIT', request({ method: 'HEAD', url: OTHER_SCRIPT_URL, resourceType: 'script' }))).toEqual({ kind: 'WITHHOLD' });
  });

  it('キャッシュの種類でない要求は、同じ URL がキャッシュにあっても FROM_RUN_CACHE にならない', () => {
    expect(decide('REVISIT', request({ resourceType: 'fetch' }))).toEqual({ kind: 'NETWORK' });
    expect(decide('REVISIT', request({ url: OTHER_SCRIPT_URL, resourceType: 'xhr' }))).toEqual({ kind: 'WITHHOLD' });
  });

  it('REVISIT の役割でキャッシュから返すと、その項目は最も新しく使われたものになる', () => {
    const limits: ResourceCacheLimits = Object.freeze({ maxEntryBytes: 4, maxTotalBytes: 8 });
    const cache = new ResourceCache({ limits });
    const urlA = `${ALLOWED_ORIGIN}/a.png`;
    const urlB = `${ALLOWED_ORIGIN}/b.png`;
    const urlC = `${ALLOWED_ORIGIN}/c.png`;
    cache.store(storableFact({ url: urlA, resourceType: 'image', body: bytes(limits.maxEntryBytes) }));
    cache.store(storableFact({ url: urlB, resourceType: 'image', body: bytes(limits.maxEntryBytes) }));

    expect(decide('REVISIT', request({ url: urlA }), cache).kind).toBe('FROM_RUN_CACHE');
    cache.store(storableFact({ url: urlC, resourceType: 'image', body: bytes(limits.maxEntryBytes) }));

    expect(cachedUrls(cache, [urlA, urlB, urlC])).toEqual([urlA, urlC]);
  });

  it('許可 Origin は Guard と同じく正規化して比べる', () => {
    const canonicalizable: ReadonlySet<string> = new Set(['HTTPS://EXAMPLE.COM:443/path']);

    expect(decide('REVISIT', request({ url: `${ALLOWED_ORIGIN}/images/other.png` }), new ResourceCache(), canonicalizable))
      .toEqual({ kind: 'NETWORK' });
    expect(decide('REVISIT', request({ url: 'http://example.com/images/other.png' }), new ResourceCache(), canonicalizable))
      .toEqual({ kind: 'WITHHOLD' });
  });

  it('解析できない URL や、不正な許可 Origin で例外を投げず、キャッシュになければ WITHHOLD にする', () => {
    expect(() => decide('REVISIT', request({ url: 'not a url' }))).not.toThrow();
    expect(decide('REVISIT', request({ url: 'not a url' }))).toEqual({ kind: 'WITHHOLD' });
    expect(decide('REVISIT', request({ url: '' }))).toEqual({ kind: 'WITHHOLD' });
    expect(decide('REVISIT', request(), new ResourceCache(), new Set(['not a URL', 'mailto:help@example.com'])))
      .toEqual({ kind: 'WITHHOLD' });
  });
});
