// P14a（Task 14〜17 の設計書 第3章、4.5.3）: Run ごとに1つの採番器が、Page・Evidence・Finding の連番を持つ。
import { describe, expect, expectTypeOf, it } from 'vitest';
import { EVIDENCE_TYPES, type EvidenceId, type EvidenceType, type PageId } from '../../src/core/contracts.js';
import { createEvidenceId, createFindingId, createPageId } from '../../src/core/ids.js';
import { IdAllocator, type IdAllocatorSnapshot } from '../../src/orchestration/id-allocator.js';

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

// 中断した Run の再開（`2026-10-01-beaksight-resumable-run-design.md` 4.2、第7章）の R1: 3つの次の連番の取り出しと、
// 取り出した値からの新しい採番器の作り直し。
describe('IdAllocator snapshot and restore', () => {
  /** ページを2つ、Evidence を3つ採番し、Finding の連番を7まで進めた採番器。 */
  const usedAllocator = (): IdAllocator => {
    const allocator = new IdAllocator();
    allocator.allocatePageId();
    allocator.allocatePageId();
    allocator.allocateEvidenceId('dom');
    allocator.allocateEvidenceId('network');
    allocator.allocateEvidenceId('safety');
    allocator.advanceFindingSequence(7);
    return allocator;
  };

  /** 保存のファイルを通したのと同じく、JSON にして読み戻した値。 */
  const throughJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

  it('takes a frozen, JSON-serializable snapshot of the next page, Evidence, and Finding sequences', () => {
    const snapshot = usedAllocator().snapshot();

    expect(snapshot).toEqual({ nextPageSequence: 3, nextEvidenceSequence: 4, nextFindingSequence: 7 });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(throughJson(snapshot)).toEqual(snapshot);
  });

  it('restores a new allocator that continues every sequence from the snapshot, like the allocator it was taken from', () => {
    const original = usedAllocator();
    const restored = IdAllocator.restore(throughJson(original.snapshot()));

    expect(restored.nextFindingSequence).toBe(7);
    expect(restored.allocatePageId()).toBe(createPageId(3));
    expect(restored.allocateEvidenceId('console')).toBe(createEvidenceId('console', 4));
    expect([original.allocatePageId(), original.allocateEvidenceId('console')]).toEqual([createPageId(3), createEvidenceId('console', 4)]);
    restored.advanceFindingSequence(9);
    expect(restored.nextFindingSequence).toBe(9);
    expect(() => restored.advanceFindingSequence(6)).toThrow(RangeError);
    expect(restored.snapshot()).toEqual({ nextPageSequence: 4, nextEvidenceSequence: 5, nextFindingSequence: 9 });
  });

  it('keeps the original allocator usable after a snapshot, and keeps the snapshot and the restored allocator independent of it', () => {
    const original = usedAllocator();
    const snapshot = original.snapshot();
    const restored = IdAllocator.restore(snapshot);

    expect(original.allocatePageId()).toBe(createPageId(3));
    expect(original.allocateEvidenceId('link')).toBe(createEvidenceId('link', 4));
    original.advanceFindingSequence(20);

    expect(snapshot).toEqual({ nextPageSequence: 3, nextEvidenceSequence: 4, nextFindingSequence: 7 });
    expect(restored.snapshot()).toEqual({ nextPageSequence: 3, nextEvidenceSequence: 4, nextFindingSequence: 7 });
    expect(original.snapshot()).toEqual({ nextPageSequence: 4, nextEvidenceSequence: 5, nextFindingSequence: 20 });
  });

  it('restores the first sequences from the snapshot of a new allocator', () => {
    const snapshot = new IdAllocator().snapshot();
    const restored = IdAllocator.restore(usedAllocator().snapshot());

    expect(snapshot).toEqual({ nextPageSequence: 1, nextEvidenceSequence: 1, nextFindingSequence: 1 });
    expect(restored.allocatePageId()).toBe(createPageId(3));
    expect(IdAllocator.restore(snapshot).allocatePageId()).toBe(createPageId(1));
  });

  const SEQUENCE_FIELDS = ['nextPageSequence', 'nextEvidenceSequence', 'nextFindingSequence'] as const;
  const INVALID_SEQUENCES = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2, '2' as unknown as number, null as unknown as number];

  it.each(SEQUENCE_FIELDS.flatMap((field) => INVALID_SEQUENCES.map((value) => [field, value] as const)))(
    'rejects restoring %s = %s, which is not a safe integer of at least the first sequence',
    (field, value) => {
      const snapshot = { ...usedAllocator().snapshot(), [field]: value };

      expect(() => IdAllocator.restore(snapshot)).toThrow(RangeError);
    },
  );

  it('has no way to set or move back the sequences of an allocator in use (only snapshot and a new restored allocator)', () => {
    expect(Object.getOwnPropertyNames(IdAllocator.prototype).sort()).toEqual(
      ['advanceFindingSequence', 'allocateEvidenceId', 'allocatePageId', 'constructor', 'nextFindingSequence', 'snapshot'],
    );
    expect(Object.getOwnPropertyDescriptor(IdAllocator.prototype, 'nextFindingSequence')?.set).toBeUndefined();
    expectTypeOf(IdAllocator.restore).returns.toEqualTypeOf<IdAllocator>();
    expectTypeOf<IdAllocator['snapshot']>().returns.toEqualTypeOf<IdAllocatorSnapshot>();
  });
});
