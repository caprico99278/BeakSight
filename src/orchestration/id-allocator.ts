import type { EvidenceId, EvidenceType, PageId } from '../core/contracts.js';
import { isNonNegativeSafeInteger } from '../core/guards.js';
import { createEvidenceId, createPageId } from '../core/ids.js';

/** 各連番の最初の値。 */
const FIRST_SEQUENCE = 1;

/** 採番器の状態（次に使う3つの連番）。JSON にできる値。 */
export interface IdAllocatorSnapshot {
  readonly nextPageSequence: number;
  readonly nextEvidenceSequence: number;
  readonly nextFindingSequence: number;
}

/**
 * Run ごとに1つ作る、Page・Evidence・Finding の連番の採番器（Task 14〜17 の設計書 第3章、4.5.3）。
 * Run Coordinator が作り、Page Auditor と Cross-page rule の呼び出しに注入する。ID の書式は `src/core/ids.ts` が決める。
 * - Evidence の連番は、Evidence の種類ごとではなく、Run で1つ。
 * - Finding の ID は `RuleEngine`（と `evaluateCrossPageRules`）が作る。評価のたびに `nextFindingSequence` を最初の連番として渡し、
 *   評価の結果の `nextFindingSequence` を `advanceFindingSequence` で戻す。`RuleEngine` のインスタンスは使い回さない。
 * ID を作れない場合（種類が閉じた一覧にない、連番が安全な整数を超える）は、連番を進めずに `RangeError` を投げる。
 * 中断した Run の再開のために、連番を `snapshot` で取り出し、`IdAllocator.restore` で新しい採番器に作り直せる。
 */
export class IdAllocator {
  #nextPageSequence = FIRST_SEQUENCE;
  #nextEvidenceSequence = FIRST_SEQUENCE;
  #nextFindingSequence = FIRST_SEQUENCE;

  /**
   * `snapshot` で取り出した連番から、新しい採番器を作る（中断した Run の再開の設計書 4.2）。作った採番器は、その連番から ID を作る。
   * 使っている採番器の連番を設定したり戻したりする口は作らない（作り直しは、新しいインスタンスを作るときだけ）。
   * 各連番が `FIRST_SEQUENCE` 以上の安全な整数でなければ、`RangeError` を投げる。
   */
  static restore(snapshot: IdAllocatorSnapshot): IdAllocator {
    const { nextPageSequence, nextEvidenceSequence, nextFindingSequence } = snapshot;
    for (const [name, sequence] of [
      ['page', nextPageSequence],
      ['Evidence', nextEvidenceSequence],
      ['Finding', nextFindingSequence],
    ] as const) {
      if (!isNonNegativeSafeInteger(sequence) || sequence < FIRST_SEQUENCE) {
        throw new RangeError(`next ${name} sequence must be a safe integer of at least ${FIRST_SEQUENCE}`);
      }
    }
    const allocator = new IdAllocator();
    allocator.#nextPageSequence = nextPageSequence;
    allocator.#nextEvidenceSequence = nextEvidenceSequence;
    allocator.#nextFindingSequence = nextFindingSequence;
    return allocator;
  }

  /** 次に使う3つの連番（中断した Run の再開の設計書 4.1）。凍結した、JSON にできる値。採番器の状態は変えない。 */
  snapshot(): IdAllocatorSnapshot {
    return Object.freeze({
      nextPageSequence: this.#nextPageSequence,
      nextEvidenceSequence: this.#nextEvidenceSequence,
      nextFindingSequence: this.#nextFindingSequence,
    });
  }

  /** 次の評価で最初に使う Finding の連番。 */
  get nextFindingSequence(): number {
    return this.#nextFindingSequence;
  }

  allocatePageId(): PageId {
    const pageId = createPageId(this.#nextPageSequence);
    this.#nextPageSequence += 1;
    return pageId;
  }

  allocateEvidenceId(type: EvidenceType): EvidenceId {
    const evidenceId = createEvidenceId(type, this.#nextEvidenceSequence);
    this.#nextEvidenceSequence += 1;
    return evidenceId;
  }

  /**
   * 評価の結果の `nextFindingSequence` まで、Finding の連番を進める。同じ値（Finding のない評価）は受け付ける。
   * 現在の連番より小さい値（戻す操作）と、0以上の安全な整数でない値は、連番を変えずに `RangeError` を投げる。
   */
  advanceFindingSequence(nextFindingSequence: number): void {
    if (!isNonNegativeSafeInteger(nextFindingSequence)) {
      throw new RangeError('next Finding sequence must be a non-negative safe integer');
    }
    if (nextFindingSequence < this.#nextFindingSequence) {
      throw new RangeError(
        `Finding sequence must not move backwards (current ${this.#nextFindingSequence}, requested ${nextFindingSequence})`,
      );
    }
    this.#nextFindingSequence = nextFindingSequence;
  }
}
