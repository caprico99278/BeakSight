// CCX-1（共通化の台帳の CC-040）: 保存から採番器と巡回の記録を作り直す関数（`restoreRunCheckpointCrawl`、`run-checkpoint.ts`）。
// Run Coordinator の再開の初めの作り直しと、保存の整合の確かめ（`checkRunCheckpointConsistency`）の両方が、この関数を使う。
// 設定は、保存の実効の設定（`effectiveConfig`）から取る（`CC-plan.md` の「設計者の判断」の 1）。
import { describe, expect, it } from 'vitest';
import type { IncompleteReasonCode } from '../../src/core/contracts.js';
import { createPageId } from '../../src/core/ids.js';
import type { StoredCrawlUrlEntry } from '../../src/orchestration/crawl-frontier.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';
import {
  RESUME_REQUEUE_SKIP_REASON_CODES,
  restoreRunCheckpointCrawl,
  type RunCheckpoint,
} from '../../src/orchestration/run-checkpoint.js';
import { createTestConfig } from '../helpers/test-config.js';

const ORIGIN = 'https://example.com';
const MAX_DEPTH = 1;
/** 保存の採番器の、次に使うページの連番（巡回の記録の最後のページの次）。 */
const NEXT_PAGE_SEQUENCE = 3;
/** 保存の採番器の、次に使う Evidence と Finding の連番（ページの連番と区別できる値）。 */
const NEXT_EVIDENCE_SEQUENCE = 7;
const NEXT_FINDING_SEQUENCE = 5;
const ALLOCATOR_SNAPSHOT = Object.freeze({ nextPageSequence: NEXT_PAGE_SEQUENCE, nextEvidenceSequence: NEXT_EVIDENCE_SEQUENCE, nextFindingSequence: NEXT_FINDING_SEQUENCE });
/** 待ち行列に戻さない理由（`RESUME_REQUEUE_SKIP_REASON_CODES` にない理由）。 */
const KEPT_SKIP_REASON_CODE: IncompleteReasonCode = 'MAX_PAGES_REACHED';

type CrawlCheckpoint = Pick<RunCheckpoint, 'allocator' | 'frontier' | 'effectiveConfig'>;

const entry = (path: string, depth: number, sequence: number, state: string, skipReason: StoredCrawlUrlEntry['skipReason'] = null) =>
  ({ url: `${ORIGIN}${path}`, depth, pageId: createPageId(sequence), state, skipReason }) as RunCheckpoint['frontier']['entries'][number];

const checkpointWith = (
  entries: readonly RunCheckpoint['frontier']['entries'][number][],
  crawl: { readonly maxDepth?: number; readonly allowedQueryParameters?: readonly string[] } = {},
  allocator: RunCheckpoint['allocator'] = ALLOCATOR_SNAPSHOT,
): CrawlCheckpoint => ({
  allocator,
  frontier: { entries },
  effectiveConfig: createTestConfig(ORIGIN, '/', {
    crawl: { maxDepth: MAX_DEPTH, allowedQueryParameters: [], ...crawl },
  }) as RunCheckpoint['effectiveConfig'],
});

const BASE_ENTRIES = [entry('/', 0, 1, 'AUDITED'), entry('/a', MAX_DEPTH, 2, 'QUEUED')];
/** `BASE_ENTRIES` に加える記録の、最初のページの連番。 */
const ADDED_ENTRY_SEQUENCE = BASE_ENTRIES.length + 1;

describe('restoreRunCheckpointCrawl (CCX-1, CC-040)', () => {
  it('restores the allocator from the checkpoint, and the frontier with that allocator', () => {
    const { allocator, frontier } = restoreRunCheckpointCrawl(checkpointWith(BASE_ENTRIES));

    expect(allocator.snapshot()).toEqual(ALLOCATOR_SNAPSHOT);
    expect(frontier.snapshot().entries.map((restored) => restored.state)).toEqual(['AUDITED', 'QUEUED']);
    expect(frontier.discover(entry('/b', MAX_DEPTH, 0, 'QUEUED').url, MAX_DEPTH)).toBe('QUEUED');
    expect(frontier.entries().at(-1)?.pageId).toBe(createPageId(NEXT_PAGE_SEQUENCE));
  });

  it('uses the given allocator instead of restoring the one of the checkpoint', () => {
    const given = new IdAllocator();
    const { allocator, frontier } = restoreRunCheckpointCrawl(checkpointWith(BASE_ENTRIES), given);

    expect(allocator).toBe(given);
    frontier.discover(entry('/b', MAX_DEPTH, 0, 'QUEUED').url, MAX_DEPTH);
    expect(frontier.entries().at(-1)?.pageId).toBe(createPageId(1));
  });

  it('takes the depth limit from the effective config of the checkpoint', () => {
    const deep = [...BASE_ENTRIES, entry('/deep', MAX_DEPTH + 1, ADDED_ENTRY_SEQUENCE, 'QUEUED')];

    expect(() => restoreRunCheckpointCrawl(checkpointWith(deep))).toThrow(RangeError);
    const { frontier } = restoreRunCheckpointCrawl(checkpointWith(deep, { maxDepth: MAX_DEPTH + 1 }));
    expect(frontier.discover(entry('/deeper', 0, 0, 'QUEUED').url, MAX_DEPTH + 2)).toBe('SKIPPED');
  });

  it('takes the allowed query parameters from the effective config of the checkpoint', () => {
    const withQuery = [...BASE_ENTRIES, entry('/c?page=2', MAX_DEPTH, ADDED_ENTRY_SEQUENCE, 'QUEUED')];

    expect(() => restoreRunCheckpointCrawl(checkpointWith(withQuery))).toThrow(RangeError);
    expect(restoreRunCheckpointCrawl(checkpointWith(withQuery, { allowedQueryParameters: ['page'] })).frontier.entries()).toHaveLength(3);
  });

  it('puts AUDITING records and SKIPPED records of RESUME_REQUEUE_SKIP_REASON_CODES back to QUEUED, and keeps the other SKIPPED records', () => {
    const entries = [
      ...BASE_ENTRIES,
      entry('/auditing', MAX_DEPTH, ADDED_ENTRY_SEQUENCE, 'AUDITING'),
      ...RESUME_REQUEUE_SKIP_REASON_CODES.map((code, index) =>
        entry(`/requeued-${index}`, MAX_DEPTH, ADDED_ENTRY_SEQUENCE + 1 + index, 'SKIPPED', { code, detail: null })),
      entry('/kept', MAX_DEPTH, ADDED_ENTRY_SEQUENCE + 1 + RESUME_REQUEUE_SKIP_REASON_CODES.length, 'SKIPPED', { code: KEPT_SKIP_REASON_CODE, detail: null }),
    ];
    const { frontier } = restoreRunCheckpointCrawl(checkpointWith(entries));

    expect(frontier.entries().map((restored) => restored.state)).toEqual([
      'AUDITED',
      'QUEUED',
      'QUEUED',
      ...RESUME_REQUEUE_SKIP_REASON_CODES.map(() => 'QUEUED'),
      'SKIPPED',
    ]);
  });

  it('throws the error of IdAllocator.restore when the allocator of the checkpoint cannot be restored', () => {
    const broken = { ...ALLOCATOR_SNAPSHOT, nextPageSequence: 0 };

    expect(() => restoreRunCheckpointCrawl(checkpointWith(BASE_ENTRIES, {}, broken))).toThrow(
      new RangeError('next page sequence must be a safe integer of at least 1'),
    );
  });
});
