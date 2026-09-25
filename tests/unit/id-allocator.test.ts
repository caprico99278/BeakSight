// P14a（Task 14〜17 の設計書 第3章、4.5.3）: Run ごとに1つの採番器が、Page・Evidence・Finding の連番を持つ。
import { describe, expect, expectTypeOf, it } from 'vitest';
import { EVIDENCE_TYPES, type EvidenceId, type EvidenceType, type PageId } from '../../src/core/contracts.js';
import { createEvidenceId, createFindingId, createPageId } from '../../src/core/ids.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';

describe('IdAllocator', () => {
  it('allocates page IDs in order with the format of src/core/ids.ts, starting at 1', () => {
    const allocator = new IdAllocator();

    expect([allocator.allocatePageId(), allocator.allocatePageId(), allocator.allocatePageId()])
      .toEqual([createPageId(1), createPageId(2), createPageId(3)]);
  });

  it('allocates Evidence IDs from one sequence for the whole Run, not one per Evidence type', () => {
    const allocator = new IdAllocator();

    const ids = [
      allocator.allocateEvidenceId('network'),
      allocator.allocateEvidenceId('console'),
      allocator.allocateEvidenceId('network'),
      allocator.allocateEvidenceId('safety'),
    ];

    expect(ids).toEqual([
      createEvidenceId('network', 1),
      createEvidenceId('console', 2),
      createEvidenceId('network', 3),
      createEvidenceId('safety', 4),
    ]);
  });

  it('never gives two Evidence records the same ID across every Evidence type', () => {
    const allocator = new IdAllocator();
    const ids = EVIDENCE_TYPES.flatMap((type) => [allocator.allocateEvidenceId(type), allocator.allocateEvidenceId(type)]);

    expect(new Set(ids).size).toBe(ids.length);
    // 接頭辞を除いた連番も、種類をまたいで重ならない。
    const sequences = ids.map((id) => id.slice(id.lastIndexOf('-') + 1));
    expect(new Set(sequences).size).toBe(sequences.length);
  });

  it('keeps the page, Evidence, and Finding sequences independent of each other', () => {
    const allocator = new IdAllocator();

    allocator.allocatePageId();
    allocator.allocatePageId();
    allocator.allocateEvidenceId('dom');

    expect(allocator.nextFindingSequence).toBe(1);
    expect(allocator.allocatePageId()).toBe(createPageId(3));
    expect(allocator.allocateEvidenceId('dom')).toBe(createEvidenceId('dom', 2));
  });

  it('reads the next Finding sequence and advances it to the nextFindingSequence of an evaluation', () => {
    const allocator = new IdAllocator();
    expect(allocator.nextFindingSequence).toBe(1);

    // 1回目の評価: 1〜3 の3件の Finding を作った（RuleEngine の結果の nextFindingSequence は 4）。
    allocator.advanceFindingSequence(4);
    expect(allocator.nextFindingSequence).toBe(4);
    expect(createFindingId(allocator.nextFindingSequence)).toBe(createFindingId(4));

    // Finding のない評価（nextFindingSequence が変わらない）は、そのまま受け付ける。
    allocator.advanceFindingSequence(4);
    expect(allocator.nextFindingSequence).toBe(4);

    allocator.advanceFindingSequence(10);
    expect(allocator.nextFindingSequence).toBe(10);
  });

  it('rejects moving the Finding sequence backwards and keeps the current sequence', () => {
    const allocator = new IdAllocator();
    allocator.advanceFindingSequence(5);

    expect(() => allocator.advanceFindingSequence(4)).toThrow(RangeError);
    expect(() => allocator.advanceFindingSequence(0)).toThrow(RangeError);
    expect(allocator.nextFindingSequence).toBe(5);
  });

  it.each([Number.NaN, 5.5, -1, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2, '6' as unknown as number])(
    'rejects advancing the Finding sequence to %s',
    (value) => {
      const allocator = new IdAllocator();

      expect(() => allocator.advanceFindingSequence(value)).toThrow(RangeError);
      expect(allocator.nextFindingSequence).toBe(1);
    },
  );

  it('rejects an Evidence type outside the closed list without consuming a sequence', () => {
    const allocator = new IdAllocator();

    expect(() => allocator.allocateEvidenceId('net' as EvidenceType)).toThrow(RangeError);
    expect(allocator.allocateEvidenceId('network')).toBe(createEvidenceId('network', 1));
  });

  it('keeps separate sequences for separate Runs', () => {
    const first = new IdAllocator();
    const second = new IdAllocator();
    first.allocatePageId();

    expect(second.allocatePageId()).toBe(createPageId(1));
  });

  it('types the allocated IDs as branded IDs', () => {
    expectTypeOf<IdAllocator['allocatePageId']>().returns.toEqualTypeOf<PageId>();
    expectTypeOf<IdAllocator['allocateEvidenceId']>().parameters.toEqualTypeOf<[EvidenceType]>();
    expectTypeOf<IdAllocator['allocateEvidenceId']>().returns.toEqualTypeOf<EvidenceId>();
    expectTypeOf<IdAllocator['nextFindingSequence']>().toEqualTypeOf<number>();
    expectTypeOf<IdAllocator['advanceFindingSequence']>().parameters.toEqualTypeOf<[number]>();
  });
});
