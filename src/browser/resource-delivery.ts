/**
 * Run 全体のリソースのキャッシュ（`ResourceCache`。設計書 4.6）と、許可された要求の届け方の判断
 * （`decideResourceDelivery`。設計書 4.7）。この意味の owner は、このファイルだけである。
 * 設計書: `doc/design/2026-10-01-beaksight-site-load-control-design.md`。
 * - Playwright に依存しない。要求と応答の事実を受け取り、判断を返すだけにする。Route の操作（`route.fulfill`、
 *   `route.abort`）と、事象の受け渡しは、呼び出し側（Guard と Context の factory）が行う。
 * - 許可の判定（authority）は行わない。Guard が許可（ALLOW）した要求の届け方を選ぶだけである。
 * - 許可 Origin の判定は、Guard と同じ `hasAllowedOrigin`（`src/safety/request-policy.ts`）に委ねる。
 * - 名前の注意: `request-policy.ts` の ALLOW の `delivery`（リダイレクトの確かめ方）とは別の意味なので、
 *   この部品の型の名前には `ResourceDelivery` を付ける。
 */
import { isPositiveSafeInteger } from '../core/guards.js';
import { hasAllowedOrigin } from '../safety/request-policy.js';

// ---------------------------------------------------------------------------------------------------------------
// キャッシュの条件と上限（設計書 4.6）
// ---------------------------------------------------------------------------------------------------------------

/** キャッシュに入れる要求の種類（Playwright の `Request.resourceType()` の値。閉じた一覧）。 */
export const RESOURCE_CACHE_RESOURCE_TYPES = Object.freeze(['stylesheet', 'script', 'image', 'font'] as const);
export type ResourceCacheResourceType = (typeof RESOURCE_CACHE_RESOURCE_TYPES)[number];

const BYTES_PER_MEBIBYTE = 1024 * 1024;

/** キャッシュの大きさの上限（バイト。本文の大きさで数える）。 */
export interface ResourceCacheLimits {
  /** 1件の本文の上限。これを超える本文は入れない。 */
  readonly maxEntryBytes: number;
  /** 合計の上限。超えたら、最も前に使われた（入れた、または引いた）ものから捨てる（LRU）。 */
  readonly maxTotalBytes: number;
}

/** 既定の上限（1件 5MB、合計 256MB）。利用者が選ぶ必要がないので、設定にはしない（設計書 3.2）。 */
export const RESOURCE_CACHE_LIMITS: ResourceCacheLimits = Object.freeze({
  maxEntryBytes: 5 * BYTES_PER_MEBIBYTE,
  maxTotalBytes: 256 * BYTES_PER_MEBIBYTE,
});

/** キャッシュに入れる応答の status。 */
export const RESOURCE_CACHE_STORABLE_STATUS = 200;

/** キャッシュに入れる（キャッシュから返す）要求の method。大文字小文字を区別せずに比べる。 */
const CACHEABLE_METHOD = 'GET';
/** これがある要求は入れない（部分の応答のため）。名前は小文字。 */
const RANGE_HEADER_NAME = 'range';
const CACHE_CONTROL_HEADER_NAME = 'cache-control';
/** `cache-control` にこの指示があれば入れない。 */
const NO_STORE_DIRECTIVE = 'no-store';
const CACHE_CONTROL_DIRECTIVE_SEPARATOR = ',';
const CACHE_CONTROL_ARGUMENT_SEPARATOR = '=';
/** 応答の本文の大きさ（バイト）を示す header（小文字）。本文を読む前に、1件の上限を超えると分かるかを確かめる。 */
const CONTENT_LENGTH_HEADER_NAME = 'content-length';
/** `content-length` の値として読む形（10進の整数）。読めない値は、大きさが分からないものとして扱う。 */
const CONTENT_LENGTH_VALUE_PATTERN = /^\d+$/u;
/**
 * 持たない応答の header（小文字）。本文は展開済みなので、符号化と長さの header を持たない。
 * `set-cookie` は、キャッシュから返すときに再生しない。
 */
const EXCLUDED_RESPONSE_HEADER_NAMES: ReadonlySet<string> = new Set([
  'content-encoding',
  CONTENT_LENGTH_HEADER_NAME,
  'transfer-encoding',
  'set-cookie',
]);
/** 小文字にそろえて同じ名前になった header の値をつなぐ区切り（HTTP の、同じ名前の header を1つにまとめる規則）。 */
const HEADER_VALUE_SEPARATOR = ', ';

// ---------------------------------------------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------------------------------------------

/** キャッシュの1件。凍結して返す（本文は、渡された値をそのまま持つ）。 */
export interface CachedResource {
  /** 鍵（完全一致）。`Vary` は考えない（設計書 4.6 の制約）。 */
  readonly url: string;
  readonly status: number;
  /** 応答の header（名前は小文字。`EXCLUDED_RESPONSE_HEADER_NAMES` を除く）。 */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

/** キャッシュに入れるかを決める、要求と応答の事実（Context の factory が `response` の事象から作る）。 */
export interface ResourceCacheStoreFact {
  readonly method: string;
  /** Playwright の `Request.resourceType()` の値。 */
  readonly resourceType: string;
  readonly url: string;
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly status: number;
  readonly responseHeaders: Readonly<Record<string, string>>;
  /** 展開済みの本文（`Buffer` または `Uint8Array`）。キャッシュは写さずに持つので、渡した後に書き換えない。 */
  readonly body: Uint8Array;
  /** キャッシュから返した応答か。真なら入れ直さない。 */
  readonly servedFromRunCache: boolean;
}

/**
 * 本文を読む前に、キャッシュに入れる見込みがあるかを決める事実（`ResourceCacheStoreFact` から本文を除いたもの。
 * `ResourceCache.mayStore` に渡す。L5b-fix-round-1）。
 */
export type ResourceCacheResponseFact = Omit<ResourceCacheStoreFact, 'body'>;

export interface ResourceCacheStats {
  readonly entryCount: number;
  /** 持っている本文の大きさの合計（バイト）。 */
  readonly totalBytes: number;
}

export interface ResourceCacheOptions {
  /** 上限。省略すると `RESOURCE_CACHE_LIMITS`（テストで小さい上限を渡すための口）。 */
  readonly limits?: ResourceCacheLimits;
}

// ---------------------------------------------------------------------------------------------------------------
// 判定の補助
// ---------------------------------------------------------------------------------------------------------------

const isResourceCacheResourceType = (resourceType: string): resourceType is ResourceCacheResourceType =>
  (RESOURCE_CACHE_RESOURCE_TYPES as readonly string[]).includes(resourceType);

/** method が GET で、種類がキャッシュの種類か（入れる条件と、キャッシュから返す条件に共通）。 */
const isCacheableRequest = (method: string, resourceType: string): boolean =>
  method.toUpperCase() === CACHEABLE_METHOD && isResourceCacheResourceType(resourceType);

/** 名前が `lowerName` の header（名前の大文字小文字を区別しない）の値の一覧。 */
const headerValues = (headers: Readonly<Record<string, string>>, lowerName: string): readonly string[] =>
  Object.entries(headers).filter(([name]) => name.toLowerCase() === lowerName).map(([, value]) => value);

/** `cache-control` の指示の名前（小文字。引数を除く）。 */
const cacheControlDirectiveName = (directive: string): string =>
  (directive.split(CACHE_CONTROL_ARGUMENT_SEPARATOR)[0] ?? '').trim().toLowerCase();

const hasNoStoreDirective = (headers: Readonly<Record<string, string>>): boolean =>
  headerValues(headers, CACHE_CONTROL_HEADER_NAME).some((value) =>
    value.split(CACHE_CONTROL_DIRECTIVE_SEPARATOR).some((directive) => cacheControlDirectiveName(directive) === NO_STORE_DIRECTIVE));

/** 持つ header（名前を小文字にそろえ、持たない header を除く）。凍結して返す。 */
const storedResponseHeaders = (headers: Readonly<Record<string, string>>): Readonly<Record<string, string>> => {
  const values = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    if (EXCLUDED_RESPONSE_HEADER_NAMES.has(lowerName)) {
      continue;
    }
    const existing = values.get(lowerName);
    values.set(lowerName, existing === undefined ? value : `${existing}${HEADER_VALUE_SEPARATOR}${value}`);
  }
  return Object.freeze(Object.fromEntries(values));
};

function validatedLimits(limits: ResourceCacheLimits): ResourceCacheLimits {
  if (!isPositiveSafeInteger(limits.maxEntryBytes) || !isPositiveSafeInteger(limits.maxTotalBytes)) {
    throw new Error('Resource cache limits must be positive safe integers');
  }
  if (limits.maxEntryBytes > limits.maxTotalBytes) {
    throw new Error('Resource cache entry limit must not exceed the total limit');
  }
  return Object.freeze({ maxEntryBytes: limits.maxEntryBytes, maxTotalBytes: limits.maxTotalBytes });
}

// ---------------------------------------------------------------------------------------------------------------
// キャッシュ（設計書 4.6）
// ---------------------------------------------------------------------------------------------------------------

/**
 * Run 全体のリソースのキャッシュ。Run Coordinator が Run の初めに1つだけ作り、Run の終わりに捨てる（ファイルには書かない）。
 * 大きさは本文で数え、合計の上限を超えたら、最も前に使われたものから捨てる（LRU）。
 */
export class ResourceCache {
  readonly #limits: ResourceCacheLimits;
  /** URL を鍵にした項目。Map の順を LRU の順（先頭が、最も前に使われたもの）として使う。 */
  readonly #entries = new Map<string, CachedResource>();
  #totalBytes = 0;

  constructor(options: ResourceCacheOptions = {}) {
    this.#limits = validatedLimits(options.limits ?? RESOURCE_CACHE_LIMITS);
  }

  /**
   * 入れる条件をすべて満たす応答を入れ、入れたかを返す。同じ URL があれば新しい内容で置き換える。
   * 条件を満たさない応答は、同じ URL のすでにある項目を変えない。
   */
  store(fact: ResourceCacheStoreFact): boolean {
    if (!this.#isStorable(fact)) {
      return false;
    }
    this.#remove(fact.url);
    this.#entries.set(fact.url, Object.freeze({
      url: fact.url,
      status: fact.status,
      headers: storedResponseHeaders(fact.responseHeaders),
      body: fact.body,
    }));
    this.#totalBytes += fact.body.byteLength;
    this.#evictLeastRecentlyUsed();
    return true;
  }

  /** URL（完全一致）の項目。見つかれば、最も新しく使われたものにして返す。 */
  lookup(url: string): CachedResource | undefined {
    const resource = this.#entries.get(url);
    if (resource !== undefined) {
      this.#entries.delete(url);
      this.#entries.set(url, resource);
    }
    return resource;
  }

  stats(): ResourceCacheStats {
    return Object.freeze({ entryCount: this.#entries.size, totalBytes: this.#totalBytes });
  }

  /**
   * 本文を読む前に、入れる見込みがあるかを答える（L5b-fix-round-1。キャッシュは変えない）。条件は、入れる条件（`store`）の、
   * 本文の大きさ以外のすべてである。応答の `content-length` が、このキャッシュの1件の上限を超えると分かる場合も、見込みなしにする
   * （分からない場合は見込みあり。本文を読んでから、`store` が本文の大きさで決める）。`store` も、この判断を使う。
   */
  mayStore(fact: ResourceCacheResponseFact): boolean {
    return !fact.servedFromRunCache
      && isCacheableRequest(fact.method, fact.resourceType)
      && fact.status === RESOURCE_CACHE_STORABLE_STATUS
      && headerValues(fact.requestHeaders, RANGE_HEADER_NAME).length === 0
      && !hasNoStoreDirective(fact.responseHeaders)
      && !this.#contentLengthExceedsEntryLimit(fact.responseHeaders);
  }

  #isStorable(fact: ResourceCacheStoreFact): boolean {
    return this.mayStore(fact) && fact.body.byteLength <= this.#limits.maxEntryBytes;
  }

  /** 応答の `content-length`（10進の整数として読める値）のどれかが、このキャッシュの1件の上限を超えるか。 */
  #contentLengthExceedsEntryLimit(headers: Readonly<Record<string, string>>): boolean {
    return headerValues(headers, CONTENT_LENGTH_HEADER_NAME).some((value) => {
      const trimmed = value.trim();
      return CONTENT_LENGTH_VALUE_PATTERN.test(trimmed) && Number(trimmed) > this.#limits.maxEntryBytes;
    });
  }

  #remove(url: string): void {
    const existing = this.#entries.get(url);
    if (existing !== undefined) {
      this.#entries.delete(url);
      this.#totalBytes -= existing.body.byteLength;
    }
  }

  /** 合計の上限に収まるまで、前に使われたものから捨てる（最後に入れた項目は、1件の上限があるので捨てられない）。 */
  #evictLeastRecentlyUsed(): void {
    for (const url of this.#entries.keys()) {
      if (this.#totalBytes <= this.#limits.maxTotalBytes) {
        return;
      }
      this.#remove(url);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 届け方の判断（設計書 4.7）
// ---------------------------------------------------------------------------------------------------------------

/**
 * Context の役割（閉じた一覧）。
 * - `PRIMARY`: Passive の Desktop と Mobile、robots.txt と sitemap.xml。すべてネットワークから取る（キャッシュに入れるだけ）。
 * - `REVISIT`: 幅の走査、Interaction。キャッシュにあるものはキャッシュから返し、許可 Origin の外へは送らない。
 */
export const RESOURCE_DELIVERY_ROLES = Object.freeze(['PRIMARY', 'REVISIT'] as const);
export type ResourceDeliveryRole = (typeof RESOURCE_DELIVERY_ROLES)[number];

/**
 * 届け方の判断（閉じた一覧）。
 * - `NETWORK`: 今のまま、ネットワークに送る。
 * - `FROM_RUN_CACHE`: キャッシュから返す（`resource` を返す）。ネットワークに送らない。
 * - `WITHHOLD`: 送らない。
 */
export type ResourceDeliveryDecision =
  | { readonly kind: 'NETWORK' }
  | { readonly kind: 'FROM_RUN_CACHE'; readonly resource: CachedResource }
  | { readonly kind: 'WITHHOLD' };

/** 届け方を決める要求の事実。 */
export interface ResourceDeliveryRequestFacts {
  readonly method: string;
  /** Playwright の `Request.resourceType()` の値。 */
  readonly resourceType: string;
  readonly url: string;
  /** ナビゲーションの要求（main frame と iframe の文書の読み込み）か。 */
  readonly isNavigationRequest: boolean;
}

export interface ResourceDeliveryInput {
  readonly role: ResourceDeliveryRole;
  readonly cache: ResourceCache;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly request: ResourceDeliveryRequestFacts;
}

const NETWORK_DECISION: ResourceDeliveryDecision = Object.freeze({ kind: 'NETWORK' });
const WITHHOLD_DECISION: ResourceDeliveryDecision = Object.freeze({ kind: 'WITHHOLD' });

/**
 * Guard が許可した要求の届け方を決める。例外を投げない（解析できない URL は、許可 Origin の外として扱う）。
 * - `PRIMARY` の役割では、常に `NETWORK`（キャッシュを引かない）。
 * - `REVISIT` の役割では、ナビゲーションの要求は `NETWORK`。GET で、キャッシュの種類で、キャッシュにあれば `FROM_RUN_CACHE`。
 *   許可 Origin の外で、キャッシュになければ `WITHHOLD`。それ以外は `NETWORK`。
 */
export function decideResourceDelivery(input: ResourceDeliveryInput): ResourceDeliveryDecision {
  const { role, cache, allowedOrigins, request } = input;
  // 役割が `REVISIT` でなければ、今のまま（ネットワーク）にする。
  if (role !== 'REVISIT' || request.isNavigationRequest) {
    return NETWORK_DECISION;
  }
  if (isCacheableRequest(request.method, request.resourceType)) {
    const resource = cache.lookup(request.url);
    if (resource !== undefined) {
      return Object.freeze({ kind: 'FROM_RUN_CACHE', resource });
    }
  }
  return hasAllowedOrigin(request.url, allowedOrigins) ? NETWORK_DECISION : WITHHOLD_DECISION;
}
