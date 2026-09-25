import type { EvidenceId, EvidenceType, PageId } from '../core/contracts.js';
import { isNonNegativeSafeInteger } from '../core/guards.js';
import { createEvidenceId, createPageId } from '../core/ids.js';

/** 各連番の最初の値。 */
const FIRST_SEQUENCE = 1;

/**
 * Run ごとに1つ作る、Page・Evidence・Finding の連番の採番器（Task 14〜17 の設計書 第3章、4.5.3）。
 * Run Coordinator が作り、Page Auditor と Cross-page rule の呼び出しに注入する。ID の書式は `src/core/ids.ts` が決める。
 * - Evidence の連番は、Evidence の種類ごとではなく、Run で1つ。
 * - Finding の ID は `RuleEngine`（と `evaluateCrossPageRules`）が作る。評価のたびに `nextFindingSequence` を最初の連番として渡し、
 *   評価の結果の `nextFindingSequence` を `advanceFindingSequence` で戻す。`RuleEngine` のインスタンスは使い回さない。
 * ID を作れない場合（種類が閉じた一覧にない、連番が安全な整数を超える）は、連番を進めずに `RangeError` を投げる。
 */
export class IdAllocator {
  #nextPageSequence = FIRST_SEQUENCE;
  #nextEvidenceSequence = FIRST_SEQUENCE;
  #nextFindingSequence = FIRST_SEQUENCE;

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
