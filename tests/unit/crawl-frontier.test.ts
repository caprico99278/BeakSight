// 中断した Run の再開（`2026-10-01-beaksight-resumable-run-design.md` 4.2、第7章）の R1: 巡回の記録（`CrawlFrontier`）の
// 取り出し（`snapshot`）と、取り出した値からの作り直し（`CrawlFrontier.restore`）。
import { describe, expect, it } from 'vitest';
import type { IncompleteReasonCode, PageAuditStatus } from '../../src/core/contracts.js';
import type { NormalizedHttpUrlEvidence } from '../../src/core/evidence-types.js';
import { createPageId } from '../../src/core/ids.js';
import { normalizeUrl } from '../../src/crawl/normalize-url.js';
import {
  CrawlFrontier,
  type CrawlFrontierRestoreOptions,
  type StoredCrawlFrontierSnapshot,
  type StoredCrawlUrlEntry,
} from '../../src/orchestration/crawl-frontier.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';

const ORIGIN = 'https://example.com';
const MAX_DEPTH = 2;
const NO_QUERY_PARAMETERS: ReadonlySet<string> = new Set();
const NO_REQUEUE: ReadonlySet<IncompleteReasonCode> = new Set();

const url = (path: string): NormalizedHttpUrlEvidence => {
  const normalized = normalizeUrl(`${ORIGIN}${path}`, `${ORIGIN}/`, NO_QUERY_PARAMETERS);
  if (!normalized.ok) {
    throw new Error(`test fixture must be a normalized URL: ${path}`);
  }
  return normalized.url;
};

/** 保存のファイルを通したのと同じく、JSON にして読み戻した値。 */
const throughJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const restoreOptions = (overrides: Partial<CrawlFrontierRestoreOptions> = {}): CrawlFrontierRestoreOptions => ({
  maxDepth: MAX_DEPTH,
  allocator: new IdAllocator(),
  allowedQueryParameters: NO_QUERY_PARAMETERS,
  requeueSkipReasonCodes: NO_REQUEUE,
  ...overrides,
});

/** Run Coordinator の BFS（`run-coordinator.ts` の `#crawl`）と同じ順の、1つの手順。 */
type Step =
  | { readonly kind: 'discover'; readonly path: string; readonly depth: number }
  /** 次の URL を取り出し、監査して終え、そのページの Link を1つ深い深さで発見する。 */
  | { readonly kind: 'audit'; readonly status: PageAuditStatus; readonly links: readonly string[] }
  /** 次の URL を取り出し、監査せずに `SKIPPED` にする（上限など）。 */
  | { readonly kind: 'skip'; readonly code: IncompleteReasonCode };

/** 手順を1つ行い、観察できる結果（`discover` と `next` の結果）を返す。 */
const runStep = (frontier: CrawlFrontier, step: Step): unknown => {
  switch (step.kind) {
    case 'discover':
      return frontier.discover(url(step.path), step.depth);
    case 'audit': {
      const entry = frontier.next();
      if (entry === undefined) {
        return { next: undefined };
      }
      frontier.markAuditing(entry.url);
      frontier.markFinished(entry.url, step.status);
      return { next: entry, discovered: step.links.map((link) => frontier.discover(url(link), entry.depth + 1)) };
    }
    case 'skip': {
      const entry = frontier.next();
      if (entry !== undefined) {
        frontier.markSkipped(entry.url, Object.freeze({ code: step.code, detail: null }));
      }
      return { next: entry };
    }
  }
};

/**
 * 深さの上限 2 の巡回。すでに発見した URL の再発見（`KNOWN`）、深さの上限による `SKIPPED`、その URL の再発見、
 * 上限による `SKIPPED`、`FAILED` を含む。
 */
const SCENARIO: readonly Step[] = [
  { kind: 'discover', path: '/', depth: 0 },
  { kind: 'audit', status: 'AUDITED', links: ['/a', '/b', '/c'] },
  { kind: 'audit', status: 'PARTIAL', links: ['/b', '/d'] },
  { kind: 'audit', status: 'FAILED', links: ['/e', '/a'] },
  { kind: 'skip', code: 'MAX_RUNTIME_REACHED' },
  { kind: 'audit', status: 'AUDITED', links: ['/f', '/a'] },
  { kind: 'audit', status: 'SKIPPED', links: ['/f', '/'] },
  { kind: 'audit', status: 'AUDITED', links: [] },
];

const SPLIT_POINTS = Array.from({ length: SCENARIO.length }, (_, index) => index + 1);

/** `steps` を新しい frontier で行う。 */
const frontierAfter = (steps: readonly Step[], allocator = new IdAllocator()): CrawlFrontier => {
  const frontier = new CrawlFrontier(MAX_DEPTH, allocator);
  for (const step of steps) {
    runStep(frontier, step);
  }
  return frontier;
};

describe('CrawlFrontier snapshot', () => {
  it('returns the records in discovery order, in the same shape as entries(), as a deeply frozen JSON-serializable value', () => {
    const frontier = frontierAfter(SCENARIO.slice(0, 6));
    const snapshot = frontier.snapshot();

    expect(snapshot.entries).toEqual(frontier.entries());
    expect(snapshot.entries.map((entry) => entry.url)).toEqual(
      ['/', '/a', '/b', '/c', '/d', '/e', '/f'].map((path) => `${ORIGIN}${path}`),
    );
    expect(snapshot.entries.map((entry) => entry.pageId)).toEqual([1, 2, 3, 4, 5, 6, 7].map(createPageId));
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
    for (const entry of snapshot.entries) {
      expect(Object.isFrozen(entry)).toBe(true);
      if (entry.skipReason !== null) {
        expect(Object.isFrozen(entry.skipReason)).toBe(true);
      }
    }
    expect(throughJson(snapshot)).toEqual(snapshot);
  });

  it('does not change after the frontier it was taken from moves on', () => {
    const frontier = frontierAfter(SCENARIO.slice(0, 2));
    const snapshot = frontier.snapshot();
    const before = throughJson(snapshot);

    for (const step of SCENARIO.slice(2)) {
      runStep(frontier, step);
    }

    expect(snapshot).toEqual(before);
    expect(snapshot.entries).toHaveLength(4);
  });
});

describe('CrawlFrontier restore', () => {
  it.each(SPLIT_POINTS)(
    'behaves as if the crawl was never interrupted when it is snapshotted after step %i and restored',
    (splitPoint) => {
      const uninterrupted = new CrawlFrontier(MAX_DEPTH, new IdAllocator());
      const uninterruptedResults = SCENARIO.map((step) => runStep(uninterrupted, step));

      const allocator = new IdAllocator();
      const interrupted = frontierAfter(SCENARIO.slice(0, splitPoint), allocator);
      const stored = throughJson({ frontier: interrupted.snapshot(), allocator: allocator.snapshot() });
      const resumed = CrawlFrontier.restore(
        stored.frontier,
        restoreOptions({ allocator: IdAllocator.restore(stored.allocator) }),
      );
      const resumedResults = SCENARIO.slice(splitPoint).map((step) => runStep(resumed, step));

      expect(resumedResults).toEqual(uninterruptedResults.slice(splitPoint));
      expect(resumed.entries()).toEqual(uninterrupted.entries());
      expect(resumed.discoveredCount).toBe(uninterrupted.discoveredCount);
      expect(resumed.next()).toEqual(uninterrupted.next());
    },
  );

  it.each(SPLIT_POINTS)(
    'rebuilds a queue whose order is the discovery order of the QUEUED records, as in the frontier it was taken from (after step %i)',
    (splitPoint) => {
      const original = frontierAfter(SCENARIO.slice(0, splitPoint));
      const queuedUrls = original.entries().filter((entry) => entry.state === 'QUEUED').map((entry) => entry.url);
      const restored = CrawlFrontier.restore(throughJson(original.snapshot()), restoreOptions());

      expect(restored.entries()).toEqual(original.entries());
      // 今の作りでは、待ち行列の順は、発見の順の `QUEUED` の記録と一致する（作り直しは、この性質に頼る）。
      expect(original.drain().map((entry) => entry.url)).toEqual(queuedUrls);
      expect(restored.drain().map((entry) => entry.url)).toEqual(queuedUrls);
    },
  );

  /**
   * `/` を監査し終え、`/a` の監査の途中（`AUDITING`）で、`/b` と `/d` を実行時間の上限で、`/c` をページ数の上限で `SKIPPED` にし、
   * `/e` が待ち行列に残っている巡回。`/deep` は深さの上限で `SKIPPED`。
   */
  const interruptedFrontier = (): CrawlFrontier => {
    const frontier = new CrawlFrontier(MAX_DEPTH, new IdAllocator());
    frontier.discover(url('/'), 0);
    for (const path of ['/a', '/b', '/c']) {
      frontier.discover(url(path), 1);
    }
    frontier.discover(url('/deep'), MAX_DEPTH + 1);
    frontier.discover(url('/d'), 1);
    frontier.discover(url('/e'), 1);
    const take = (expectedPath: string) => {
      const entry = frontier.next();
      expect(entry?.url).toBe(url(expectedPath));
      return url(expectedPath);
    };
    const root = take('/');
    frontier.markAuditing(root);
    frontier.markFinished(root, 'AUDITED');
    frontier.markAuditing(take('/a'));
    frontier.markSkipped(take('/b'), Object.freeze({ code: 'MAX_RUNTIME_REACHED', detail: null }));
    frontier.markSkipped(take('/c'), Object.freeze({ code: 'MAX_PAGES_REACHED', detail: null }));
    frontier.markSkipped(take('/d'), Object.freeze({ code: 'MAX_RUNTIME_REACHED', detail: null }));
    return frontier;
  };

  it('puts AUDITING records and SKIPPED records with a requeued reason back to QUEUED, and queues them in discovery order', () => {
    const restored = CrawlFrontier.restore(
      throughJson(interruptedFrontier().snapshot()),
      restoreOptions({ requeueSkipReasonCodes: new Set<IncompleteReasonCode>(['MAX_RUNTIME_REACHED']) }),
    );

    expect(restored.entries().map(({ url: entryUrl, state, skipReason }) => ({ url: entryUrl, state, skipReason }))).toEqual([
      { url: url('/'), state: 'AUDITED', skipReason: null },
      { url: url('/a'), state: 'QUEUED', skipReason: null },
      { url: url('/b'), state: 'QUEUED', skipReason: null },
      { url: url('/c'), state: 'SKIPPED', skipReason: { code: 'MAX_PAGES_REACHED', detail: null } },
      { url: url('/deep'), state: 'SKIPPED', skipReason: { code: 'MAX_DEPTH_REACHED', detail: null } },
      { url: url('/d'), state: 'QUEUED', skipReason: null },
      { url: url('/e'), state: 'QUEUED', skipReason: null },
    ]);
    expect(restored.drain().map((entry) => entry.url)).toEqual(['/a', '/b', '/d', '/e'].map(url));
  });

  it('puts AUDITING records back to QUEUED even when no SKIPPED reason is requeued, and keeps every SKIPPED record', () => {
    const restored = CrawlFrontier.restore(throughJson(interruptedFrontier().snapshot()), restoreOptions());

    expect(restored.entries().map((entry) => [entry.state, entry.skipReason?.code ?? null])).toEqual([
      ['AUDITED', null],
      ['QUEUED', null],
      ['SKIPPED', 'MAX_RUNTIME_REACHED'],
      ['SKIPPED', 'MAX_PAGES_REACHED'],
      ['SKIPPED', 'MAX_DEPTH_REACHED'],
      ['SKIPPED', 'MAX_RUNTIME_REACHED'],
      ['QUEUED', null],
    ]);
    const next = restored.next();
    expect(next?.url).toBe(url('/a'));
    if (next !== undefined) {
      restored.markAuditing(next.url);
      restored.markFinished(next.url, 'AUDITED');
    }
    expect(restored.drain().map((entry) => entry.url)).toEqual([url('/e')]);
  });

  it('keeps the page ID and depth of every record, and lets the requeued records go through the usual state transitions', () => {
    const original = interruptedFrontier();
    const restored = CrawlFrontier.restore(
      throughJson(original.snapshot()),
      restoreOptions({ requeueSkipReasonCodes: new Set<IncompleteReasonCode>(['MAX_RUNTIME_REACHED']) }),
    );

    expect(restored.entries().map(({ url: entryUrl, depth, pageId }) => ({ url: entryUrl, depth, pageId })))
      .toEqual(original.entries().map(({ url: entryUrl, depth, pageId }) => ({ url: entryUrl, depth, pageId })));
    const next = restored.next();
    expect(next).toEqual({ url: url('/a'), depth: 1, pageId: createPageId(2), state: 'QUEUED', skipReason: null });
    if (next !== undefined) {
      restored.markAuditing(next.url);
      restored.markSkipped(next.url, Object.freeze({ code: 'EXECUTION_INCOMPLETE', detail: null }));
      expect(() => restored.markFinished(next.url, 'AUDITED')).toThrow(/invalid crawl URL state transition/u);
    }
  });

  it('answers KNOWN when a URL SKIPPED by the depth limit is discovered again after the restore', () => {
    const restored = CrawlFrontier.restore(throughJson(interruptedFrontier().snapshot()), restoreOptions());

    expect(restored.discover(url('/deep'), MAX_DEPTH + 1)).toBe('KNOWN');
    expect(restored.discover(url('/deep'), 1)).toBe('KNOWN');
    expect(restored.discover(url('/c'), 1)).toBe('KNOWN');
    expect(restored.discoveredCount).toBe(7);
  });

  it('allocates the page IDs of newly discovered URLs with the given allocator, and checks their depth against the given maxDepth', () => {
    const allocator = new IdAllocator();
    for (let sequence = 1; sequence <= 7; sequence += 1) {
      allocator.allocatePageId();
    }
    const restored = CrawlFrontier.restore(throughJson(interruptedFrontier().snapshot()), restoreOptions({ allocator }));

    expect(restored.discover(url('/g'), MAX_DEPTH)).toBe('QUEUED');
    expect(restored.discover(url('/h'), MAX_DEPTH + 1)).toBe('SKIPPED');
    expect(restored.entries().slice(-2)).toEqual([
      { url: url('/g'), depth: MAX_DEPTH, pageId: createPageId(8), state: 'QUEUED', skipReason: null },
      { url: url('/h'), depth: MAX_DEPTH + 1, pageId: createPageId(9), state: 'SKIPPED', skipReason: { code: 'MAX_DEPTH_REACHED', detail: null } },
    ]);
    expect(restored.drain().map((entry) => entry.url)).toEqual(['/a', '/e', '/g'].map(url));
  });

  it('copies the input, so mutating it after the restore does not change the restored frontier', () => {
    interface MutableStoredEntry {
      url: string;
      depth: number;
      pageId: string;
      state: string;
      skipReason: { code: string; detail: string | null } | null;
    }
    const stored = throughJson(interruptedFrontier().snapshot()) as unknown as { entries: MutableStoredEntry[] };
    const restored = CrawlFrontier.restore(stored, restoreOptions());
    const before = throughJson(restored.entries());

    const [, auditing, skipped] = stored.entries;
    expect(skipped?.skipReason).not.toBeNull();
    if (auditing !== undefined && skipped?.skipReason) {
      auditing.depth = 0;
      skipped.state = 'AUDITED';
      skipped.skipReason.code = 'MAX_PAGES_REACHED';
    }
    stored.entries.pop();

    expect(restored.entries()).toEqual(before);
    expect(restored.drain().map((entry) => entry.url)).toEqual(['/a', '/e'].map(url));
  });
});

describe('CrawlFrontier restore rejects invalid records', () => {
  const record = (
    path: string,
    depth: number,
    sequence: number,
    state: string,
    skipReason: StoredCrawlUrlEntry['skipReason'] = null,
  ): StoredCrawlUrlEntry => ({ url: `${ORIGIN}${path}`, depth, pageId: createPageId(sequence), state, skipReason });

  /** すべての状態を含む、正しい記録。 */
  const VALID_ENTRIES: readonly StoredCrawlUrlEntry[] = [
    record('/', 0, 1, 'AUDITED'),
    record('/a', 1, 2, 'FAILED'),
    record('/b', 1, 3, 'AUDITING'),
    record('/c', 1, 4, 'QUEUED'),
    record('/deep', MAX_DEPTH + 1, 5, 'SKIPPED', { code: 'MAX_DEPTH_REACHED', detail: null }),
    record('/d', 1, 6, 'SKIPPED', { code: 'MAX_PAGES_REACHED', detail: null }),
  ];
  const QUEUED_INDEX = 3;
  const SKIPPED_INDEX = 5;

  const withEntry = (index: number, patch: Partial<StoredCrawlUrlEntry>): StoredCrawlFrontierSnapshot => ({
    entries: VALID_ENTRIES.map((entry, entryIndex) => (entryIndex === index ? { ...entry, ...patch } : entry)),
  });

  it('accepts the valid records used as the base of the invalid cases', () => {
    const restored = CrawlFrontier.restore({ entries: VALID_ENTRIES }, restoreOptions());

    expect(restored.entries().map((entry) => entry.state)).toEqual(['AUDITED', 'FAILED', 'QUEUED', 'QUEUED', 'SKIPPED', 'SKIPPED']);
  });

  it('accepts URLs whose query is already in the normalized form for the allowed query parameters', () => {
    const restored = CrawlFrontier.restore(
      withEntry(QUEUED_INDEX, { url: `${ORIGIN}/c?a=1&page=2` }),
      restoreOptions({ allowedQueryParameters: new Set(['page', 'a']) }),
    );

    expect(restored.entries()[QUEUED_INDEX]?.url).toBe(`${ORIGIN}/c?a=1&page=2`);
  });

  const QUERY_PARAMETERS_PAGE_AND_A: ReadonlySet<string> = new Set(['page', 'a']);

  it.each<[string, StoredCrawlFrontierSnapshot, RegExp, Partial<CrawlFrontierRestoreOptions>?]>([
    ['a state outside CRAWL_URL_STATES', withEntry(QUEUED_INDEX, { state: 'PENDING' }), /unsupported crawl URL state/u],
    ['the transient DISCOVERED state', withEntry(QUEUED_INDEX, { state: 'DISCOVERED' }), /DISCOVERED/u],
    ['SKIPPED without a reason', withEntry(SKIPPED_INDEX, { skipReason: null }), /SKIPPED needs a skip reason/u],
    ['QUEUED with a reason', withEntry(QUEUED_INDEX, { skipReason: { code: 'MAX_PAGES_REACHED', detail: null } }), /only SKIPPED/u],
    ['AUDITING with a reason', withEntry(2, { skipReason: { code: 'MAX_PAGES_REACHED', detail: null } }), /only SKIPPED/u],
    ['AUDITED with a reason', withEntry(0, { skipReason: { code: 'MAX_PAGES_REACHED', detail: null } }), /only SKIPPED/u],
    ['a reason code outside the closed list', withEntry(SKIPPED_INDEX, { skipReason: { code: 'NOT_A_REASON', detail: null } }), /skip reason code/u],
    [
      'a reason detail that is neither a string nor null',
      withEntry(SKIPPED_INDEX, { skipReason: { code: 'MAX_PAGES_REACHED', detail: 1 as unknown as string } }),
      /skip reason detail/u,
    ],
    ['a negative depth', withEntry(QUEUED_INDEX, { depth: -1 }), /depth must be a non-negative safe integer/u],
    ['a fractional depth', withEntry(QUEUED_INDEX, { depth: 1.5 }), /depth must be a non-negative safe integer/u],
    ['a NaN depth', withEntry(QUEUED_INDEX, { depth: Number.NaN }), /depth must be a non-negative safe integer/u],
    ['a string depth', withEntry(QUEUED_INDEX, { depth: '1' as unknown as number }), /depth must be a non-negative safe integer/u],
    ['a depth beyond maxDepth that is not SKIPPED by the depth limit', withEntry(QUEUED_INDEX, { depth: MAX_DEPTH + 1 }), /max depth/u],
    ['a page ID with too few digits', withEntry(QUEUED_INDEX, { pageId: 'PAGE-4' }), /page ID/u],
    ['a page ID with another prefix', withEntry(QUEUED_INDEX, { pageId: 'page-000004' }), /page ID/u],
    ['an empty page ID', withEntry(QUEUED_INDEX, { pageId: '' }), /page ID/u],
    ['a URL with a fragment', withEntry(QUEUED_INDEX, { url: `${ORIGIN}/c#top` }), /normalized/u],
    ['a URL with non-canonical percent encoding', withEntry(QUEUED_INDEX, { url: `${ORIGIN}/%7ec` }), /normalized/u],
    ['a URL with a tracking parameter', withEntry(QUEUED_INDEX, { url: `${ORIGIN}/c?utm_source=ad` }), /normalized/u],
    ['a URL with a query parameter that is not allowed', withEntry(QUEUED_INDEX, { url: `${ORIGIN}/c?page=2` }), /normalized/u],
    [
      'a URL with an unsorted query',
      withEntry(QUEUED_INDEX, { url: `${ORIGIN}/c?page=2&a=1` }),
      /normalized/u,
      { allowedQueryParameters: QUERY_PARAMETERS_PAGE_AND_A },
    ],
    ['a URL in upper case', withEntry(QUEUED_INDEX, { url: 'HTTPS://EXAMPLE.COM/c' }), /normalized/u],
    ['a URL without the root path', withEntry(0, { url: ORIGIN }), /normalized/u],
    ['a relative URL', withEntry(QUEUED_INDEX, { url: '/c' }), /normalized/u],
    ['a URL that is not http(s)', withEntry(QUEUED_INDEX, { url: 'ftp://example.com/c' }), /normalized/u],
    ['a URL with credentials', withEntry(QUEUED_INDEX, { url: 'https://user:secret@example.com/c' }), /normalized/u],
  ])('rejects %s with a RangeError', (_description, snapshot, message, options = {}) => {
    expect(() => CrawlFrontier.restore(snapshot, restoreOptions(options))).toThrow(RangeError);
    expect(() => CrawlFrontier.restore(snapshot, restoreOptions(options))).toThrow(message);
  });

  it('does not repeat the credentials of a rejected URL in the error message', () => {
    let rejection: unknown;
    try {
      CrawlFrontier.restore(withEntry(QUEUED_INDEX, { url: 'https://user:secret@example.com/c' }), restoreOptions());
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(RangeError);
    expect(String(rejection)).not.toContain('secret');
  });

  it('rejects requeueing records SKIPPED by the depth limit, which would queue a URL beyond maxDepth', () => {
    expect(() => CrawlFrontier.restore(
      { entries: VALID_ENTRIES },
      restoreOptions({ requeueSkipReasonCodes: new Set<IncompleteReasonCode>(['MAX_DEPTH_REACHED']) }),
    )).toThrow(/max depth/u);
  });

  it('rejects the same URL twice', () => {
    expect(() => CrawlFrontier.restore(
      { entries: [...VALID_ENTRIES, record('/c', 1, 7, 'QUEUED')] },
      restoreOptions(),
    )).toThrow(/URL twice/u);
  });

  it('rejects the same page ID twice', () => {
    expect(() => CrawlFrontier.restore(
      { entries: [...VALID_ENTRIES, record('/e', 1, 6, 'QUEUED')] },
      restoreOptions(),
    )).toThrow(/page ID twice/u);
  });

  it.each([-1, 1.5, Number.NaN])('rejects a maxDepth of %s', (maxDepth) => {
    expect(() => CrawlFrontier.restore({ entries: VALID_ENTRIES }, restoreOptions({ maxDepth }))).toThrow(RangeError);
  });
});

// SU5（サイトが応答しないときに Run を止める設計書 3.5.2）: サイトの不調で捨てた URL（理由 `SITE_UNAVAILABLE`、`detail` あり）を、同じ実行の
// 中で 1 回だけ確かめ直すための操作。待ち行列を通さずに `AUDITING` に戻す（次に監査するのは、その URL である）。ほかの状態と理由からは戻さない。
describe('CrawlFrontier requeueForRecheck (site unavailability design 3.5.2, SU5)', () => {
  const SITE_UNAVAILABLE_TRIGGER = Object.freeze({ code: 'SITE_UNAVAILABLE', detail: 'desktop:passive:TIMEOUT' } as const);
  const SITE_UNAVAILABLE_REST = Object.freeze({ code: 'SITE_UNAVAILABLE', detail: null } as const);

  /** 開始の URL を監査し、/a を取り出して監査の途中にした frontier（/b は待ち行列に残る）。 */
  const auditingA = (): { readonly frontier: CrawlFrontier; readonly a: NormalizedHttpUrlEvidence } => {
    const frontier = frontierAfter([
      { kind: 'discover', path: '/', depth: 0 },
      { kind: 'audit', status: 'AUDITED', links: ['/a', '/b'] },
    ]);
    const next = frontier.next();
    if (next === undefined) {
      throw new Error('the fixture must have /a queued');
    }
    frontier.markAuditing(next.url);
    return { frontier, a: next.url };
  };

  it('puts a URL SKIPPED with SITE_UNAVAILABLE and a detail back to AUDITING without the skip reason, and leaves the queue as it is', () => {
    const { frontier, a } = auditingA();
    frontier.markSkipped(a, SITE_UNAVAILABLE_TRIGGER);
    expect(frontier.entries()[1]).toMatchObject({ url: a, state: 'SKIPPED', skipReason: SITE_UNAVAILABLE_TRIGGER });

    frontier.requeueForRecheck(a);

    expect(frontier.entries()[1]).toEqual({ url: a, depth: 1, pageId: createPageId(2), state: 'AUDITING', skipReason: null });
    // 待ち行列は変わらない（次は /b）。発見した URL の数も変わらない。
    expect(frontier.discoveredCount).toBe(3);
    expect(frontier.next()?.url).toBe(url('/b'));
    // 戻した後は、今までどおりの遷移を受け付ける（終える、または、また捨てる）。
    frontier.markSkipped(a, SITE_UNAVAILABLE_TRIGGER);
    expect(frontier.entries()[1]).toMatchObject({ state: 'SKIPPED', skipReason: SITE_UNAVAILABLE_TRIGGER });
    frontier.requeueForRecheck(a);
    frontier.markFinished(a, 'AUDITED');
    expect(frontier.entries()[1]).toMatchObject({ state: 'AUDITED', skipReason: null });
  });

  it('keeps the snapshot of the frontier in the same shape (no new state), before and after the requeue', () => {
    const { frontier, a } = auditingA();
    frontier.markSkipped(a, SITE_UNAVAILABLE_TRIGGER);
    const skipped = throughJson(frontier.snapshot());

    frontier.requeueForRecheck(a);

    expect(skipped.entries[1]).toMatchObject({ state: 'SKIPPED', skipReason: SITE_UNAVAILABLE_TRIGGER });
    expect(throughJson(frontier.snapshot()).entries[1]).toMatchObject({ state: 'AUDITING', skipReason: null });
    // 戻した後の記録も、今までどおり作り直せる（`AUDITING` は `QUEUED` に戻る）。
    const restored = CrawlFrontier.restore(throughJson(frontier.snapshot()), restoreOptions());
    expect(restored.entries()[1]).toMatchObject({ url: a, state: 'QUEUED', skipReason: null });
  });

  it.each([
    ['SKIPPED with SITE_UNAVAILABLE without a detail (a URL that was not started)', (frontier: CrawlFrontier, a: NormalizedHttpUrlEvidence): void => {
      frontier.markSkipped(a, SITE_UNAVAILABLE_REST);
    }],
    ['SKIPPED with another reason', (frontier: CrawlFrontier, a: NormalizedHttpUrlEvidence): void => {
      frontier.markSkipped(a, Object.freeze({ code: 'MAX_RUNTIME_REACHED', detail: null }));
    }],
    ['AUDITING', (): void => undefined],
    ['AUDITED', (frontier: CrawlFrontier, a: NormalizedHttpUrlEvidence): void => {
      frontier.markFinished(a, 'AUDITED');
    }],
    ['FAILED', (frontier: CrawlFrontier, a: NormalizedHttpUrlEvidence): void => {
      frontier.markFinished(a, 'FAILED');
    }],
  ] as const)('throws and changes nothing for a URL that is %s', (_name, arrange) => {
    const { frontier, a } = auditingA();
    arrange(frontier, a);
    const before = frontier.snapshot();

    expect(() => frontier.requeueForRecheck(a)).toThrow(/invalid crawl URL state transition/u);

    expect(frontier.snapshot()).toEqual(before);
  });

  it('throws for a QUEUED URL and for a URL that was not discovered', () => {
    const { frontier } = auditingA();
    const before = frontier.snapshot();

    expect(() => frontier.requeueForRecheck(url('/b'))).toThrow(/invalid crawl URL state transition/u);
    expect(() => frontier.requeueForRecheck(url('/unknown'))).toThrow(/not discovered/u);

    expect(frontier.snapshot()).toEqual(before);
  });
});
