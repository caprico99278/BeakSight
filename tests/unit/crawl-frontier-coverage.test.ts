// COV-4（網羅の設計書 `doc/design/2026-11-09-beaksight-coverage-by-state-design.md` 3.2 の 6）: 見るだけの点検の巡回の記録（`CrawlFrontier`）の中の待ち行列を、
// 共通の部品（`CoverageQueue`）に寄せる。ブラウザを使わない。
// - 読んだページの事実（構造の鍵と出た辺。リンクと同じ Origin の frame）を `completePage` で渡す。終わりは待ち行列が空になったとき。
// - 終わりのない続き（日付の「次へ」など）は、新しい場所の鍵か構造の鍵が出なくなったら閉じ、閉じた記録を残す。
// - 深さは記録だけ（利用者が指定したときだけ打ち切る）。
// - checkpoint: 新しい形（待ち行列の書き出しつき）から作り直せる。前の版（記録だけ）は、QUEUED を待ち行列の入口に、AUDITED・FAILED・SKIPPED を読み終えた
//   ものとして読み替えて続ける（設計者の判断 2026-11-10）。
import { describe, expect, it } from 'vitest';
import type { IncompleteReasonCode } from '../../src/core/contracts.js';
import type { NormalizedHttpUrlEvidence } from '../../src/core/evidence-types.js';
import { createPageId, createSha256Fingerprint } from '../../src/core/ids.js';
import { normalizeUrl } from '../../src/crawl/normalize-url.js';
import { CrawlFrontier, type CrawlPageEdge, type StoredCrawlFrontierSnapshot } from '../../src/orchestration/crawl-frontier.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';

const ORIGIN = 'https://example.com';
const ALL_QUERY: ReadonlySet<string> = new Set();
const NO_REQUEUE: ReadonlySet<IncompleteReasonCode> = new Set();

const url = (path: string): NormalizedHttpUrlEvidence => {
  const normalized = normalizeUrl(`${ORIGIN}${path}`, `${ORIGIN}/`, ALL_QUERY);
  if (!normalized.ok) {
    throw new Error(`test fixture must be a normalized URL: ${path}`);
  }
  return normalized.url;
};
const link = (path: string): CrawlPageEdge => ({ kind: 'LINK', url: url(path) });
const frame = (path: string): CrawlPageEdge => ({ kind: 'FRAME', url: url(path) });
const STRUCTURE_A = createSha256Fingerprint('structure-a');
const STRUCTURE_B = createSha256Fingerprint('structure-b');
const throughJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** 次の URL を取り出し、監査を終え、その事実を渡す（Run Coordinator の手順と同じ）。 */
const auditNext = (frontier: CrawlFrontier, structureKey: string, edges: readonly CrawlPageEdge[]): string | undefined => {
  const entry = frontier.next();
  if (entry === undefined) {
    return undefined;
  }
  frontier.markAuditing(entry.url);
  frontier.markFinished(entry.url, 'AUDITED');
  frontier.completePage(entry.url, { structureKey, edges });
  return entry.url;
};

describe('COV-4: the crawl frontier on the coverage queue', () => {
  it('queues the links and the same-origin frames of a read page, with page IDs in the found order, and ends when the queue is empty', () => {
    const frontier = new CrawlFrontier(undefined, new IdAllocator());
    frontier.discover(url('/'), 0);
    expect(auditNext(frontier, STRUCTURE_A, [link('/a'), frame('/frame.html'), link('/a')])).toBe(url('/'));
    expect(frontier.entries().map(({ url: value, depth, state }) => [value, depth, state])).toEqual([
      [url('/'), 0, 'AUDITED'],
      [url('/a'), 1, 'QUEUED'],
      [url('/frame.html'), 1, 'QUEUED'],
    ]);
    expect(auditNext(frontier, STRUCTURE_B, [link('/'), link('/b')])).toBe(url('/a'));
    expect(auditNext(frontier, STRUCTURE_A, [])).toBe(url('/frame.html'));
    expect(auditNext(frontier, STRUCTURE_A, [])).toBe(url('/b'));
    expect(frontier.next()).toBeUndefined();
    expect(frontier.entries().every(({ state }) => state === 'AUDITED')).toBe(true);
  });

  it('keeps the query names and values as different pages, and closes an endless continuation when nothing new appears', () => {
    const frontier = new CrawlFrontier(undefined, new IdAllocator());
    frontier.discover(url('/'), 0);
    auditNext(frontier, STRUCTURE_A, [link('/list?page=1'), link('/calendar?day=1')]);
    // 一覧のページ送りは、新しい場所（品物の画面）が出る間は続く。
    auditNext(frontier, STRUCTURE_B, [link('/list?page=2'), link('/item/1')]);
    // 日付の「次へ」は、同じ構造で新しいものが出ない。
    auditNext(frontier, STRUCTURE_B, [link('/calendar?day=2')]);
    auditNext(frontier, STRUCTURE_B, [link('/list?page=3'), link('/item/2')]);
    auditNext(frontier, STRUCTURE_A, []);
    auditNext(frontier, STRUCTURE_B, [link('/calendar?day=3')]);
    for (let read = auditNext(frontier, STRUCTURE_B, []); read !== undefined; read = auditNext(frontier, STRUCTURE_B, [])) {
      // 残りを読み終える。
    }
    const urls = frontier.entries().map(({ url: value }) => value);
    expect(urls).toEqual(expect.arrayContaining([url('/list?page=1'), url('/list?page=2'), url('/list?page=3'), url('/calendar?day=1'), url('/calendar?day=2')]));
    expect(urls).not.toContain(url('/calendar?day=3'));
    // 日付の鎖は、続き（day=3）を入れずに閉じた記録が残る。
    expect(frontier.snapshot().coverage?.closedChains).toContainEqual(
      expect.objectContaining({ kind: 'LINK', reason: 'NO_NEW_LOCATION_OR_STRUCTURE', droppedEdgeCount: 1 }),
    );
  });

  it('records the depth without a limit, and stops only at the depth the user gave', () => {
    const unlimited = new CrawlFrontier(undefined, new IdAllocator());
    unlimited.discover(url('/'), 0);
    auditNext(unlimited, STRUCTURE_A, [link('/1')]);
    auditNext(unlimited, STRUCTURE_B, [link('/1/2')]);
    expect(unlimited.entries().map(({ depth, state }) => [depth, state])).toEqual([[0, 'AUDITED'], [1, 'AUDITED'], [2, 'QUEUED']]);

    const limited = new CrawlFrontier(1, new IdAllocator());
    limited.discover(url('/'), 0);
    auditNext(limited, STRUCTURE_A, [link('/1')]);
    auditNext(limited, STRUCTURE_B, [link('/1/2')]);
    expect(limited.entries().at(-1)).toMatchObject({ depth: 2, state: 'SKIPPED', skipReason: { code: 'MAX_DEPTH_REACHED' } });
    expect(limited.next()).toBeUndefined();
  });

  it('restores the frontier and its coverage queue from the new snapshot, and goes on in the same order', () => {
    const frontier = new CrawlFrontier(undefined, new IdAllocator());
    frontier.discover(url('/'), 0);
    auditNext(frontier, STRUCTURE_A, [link('/a'), link('/b')]);
    const stored = throughJson(frontier.snapshot());
    expect(stored.coverage?.format).toBe('beaksight-coverage-queue/2');
    const restored = CrawlFrontier.restore(stored as StoredCrawlFrontierSnapshot, {
      maxDepth: undefined, allocator: new IdAllocator(), allowedQueryParameters: ALL_QUERY, requeueSkipReasonCodes: NO_REQUEUE,
    });
    expect(auditNext(restored, STRUCTURE_B, [link('/a'), link('/c')])).toBe(url('/a'));
    expect(auditNext(restored, STRUCTURE_B, [])).toBe(url('/b'));
    expect(auditNext(restored, STRUCTURE_B, [])).toBe(url('/c'));
    expect(restored.next()).toBeUndefined();
  });

  it('reads an earlier snapshot without the coverage queue: QUEUED records are the entrances, the others are read', () => {
    const page = (n: number): string => `PAGE-${String(n).padStart(6, '0')}`;
    const earlier: StoredCrawlFrontierSnapshot = {
      entries: [
        { url: url('/'), depth: 0, pageId: page(1), state: 'AUDITED', skipReason: null },
        { url: url('/a'), depth: 1, pageId: page(2), state: 'FAILED', skipReason: null },
        { url: url('/b'), depth: 1, pageId: page(3), state: 'QUEUED', skipReason: null },
        { url: url('/c'), depth: 1, pageId: page(4), state: 'AUDITING', skipReason: null },
        { url: url('/d'), depth: 1, pageId: page(5), state: 'SKIPPED', skipReason: { code: 'MAX_PAGES_REACHED', detail: null } },
      ],
    };
    const allocator = IdAllocator.restore({ nextPageSequence: 6, nextEvidenceSequence: 1, nextFindingSequence: 1 });
    const restored = CrawlFrontier.restore(earlier, {
      maxDepth: undefined, allocator, allowedQueryParameters: ALL_QUERY, requeueSkipReasonCodes: NO_REQUEUE,
    });
    // 監査の途中だった /c は待ち行列に戻る。読み終えたもの（/・/a・/d）は渡さない。
    expect(auditNext(restored, STRUCTURE_A, [link('/'), link('/e')])).toBe(url('/b'));
    expect(auditNext(restored, STRUCTURE_A, [])).toBe(url('/c'));
    expect(auditNext(restored, STRUCTURE_A, [])).toBe(url('/e'));
    expect(restored.next()).toBeUndefined();
    expect(restored.entries().find(({ url: value }) => value === url('/e'))?.pageId).toBe(page(6));
  });
});

// DUP（設計書 `2026-11-18-beaksight-same-structure-pages-design.md` 2 章）: 同じ作りの 1 回目と、点検を終えた画面の中身の表は、巡回の保存に残り、再開でも引き継ぐ。
describe('DUP: the table of the first pages of each template', () => {
  const TEMPLATE = createSha256Fingerprint('template');
  const CONTENT = createSha256Fingerprint('content');
  const OTHER = createSha256Fingerprint('other-content');
  const page = createPageId;

  it('takes the first fully audited page of a template, finds an audited page of the same content, and keeps them after a resume', () => {
    const frontier = new CrawlFrontier(undefined, new IdAllocator());
    expect(frontier.pageReferenceOf(TEMPLATE)).toBeNull();
    frontier.acceptPageReference({ templateKey: TEMPLATE, pageId: page(1), depth: 'FULL', contentDigest: CONTENT });
    frontier.acceptPageReference({ templateKey: TEMPLATE, pageId: page(2), depth: 'FULL', contentDigest: null });
    frontier.acceptPageReference({ templateKey: TEMPLATE, pageId: page(3), depth: 'LIGHT', contentDigest: OTHER });
    const options = { maxDepth: undefined, allocator: new IdAllocator(), allowedQueryParameters: new Set<string>(), requeueSkipReasonCodes: NO_REQUEUE };
    const restored = CrawlFrontier.restore(JSON.parse(JSON.stringify(frontier.snapshot())) as StoredCrawlFrontierSnapshot, options);
    for (const table of [frontier, restored]) {
      expect(table.pageReferenceOf(TEMPLATE)).toBe(page(1));
      expect(table.samePageOf(TEMPLATE, CONTENT)).toBe(page(1));
      expect(table.samePageOf(TEMPLATE, OTHER)).toBe(page(3));
      expect(table.samePageOf(TEMPLATE, createSha256Fingerprint('unknown'))).toBeNull();
    }
  });
});
