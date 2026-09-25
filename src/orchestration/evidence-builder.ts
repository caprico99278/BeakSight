import {
  EVIDENCE_TYPES,
  VIEWPORT_PROFILES,
  type EvidencePayloadByType,
  type EvidenceRecordFor,
  type EvidenceType,
  type PageId,
  type ViewportProfile,
} from '../core/contracts.js';
import { deepFreeze } from '../core/immutable.js';
import type { IdAllocator } from './id-allocator.js';

/** `createEvidenceRecord` に渡す、1つの Evidence の中身。payload の型は、Evidence の種類で決まる。 */
export interface EvidenceRecordInput<TType extends EvidenceType> {
  readonly type: TType;
  readonly pageId: PageId;
  /** Evidence を集めたビューポート。ビューポートによらない Evidence は `null`。 */
  readonly viewport: ViewportProfile | null;
  readonly payload: EvidencePayloadByType[TType];
}

/** Evidence の ID と観測の時刻を決めるもの。Run Coordinator が作って注入する（Task 14〜17 の設計書 第3章、4.5.3）。 */
export interface EvidenceRecordContext {
  /** Run で1つの採番器。 */
  readonly allocator: IdAllocator;
  /** `observedAt` に使う時計。 */
  readonly clock: () => Date;
}

/**
 * collector の出力を、ID 付きの `EvidenceRecord` に包む唯一の関数（Task 14〜17 の設計書 第3章、4.5.3）。
 * - `evidenceId` は、採番器の Run で1つの連番から作る（ID の書式は `src/core/ids.ts`）。
 * - `observedAt` は、時計の時刻の ISO 8601 の文字列にする。時計は1回だけ読む。
 * - payload は複製してから、記録全体を深く凍結する。呼び出し側の payload が浅くしか凍結されていなくても、
 *   また後で変更されても、記録は変わらない。
 *
 * 引数が不正な場合（種類が `EVIDENCE_TYPES` にない、pageId が文字列でない、ビューポートが `VIEWPORT_PROFILES` にも
 * `null` にも当たらない、時計が有効な `Date` を返さない）は、連番を進めずに `RangeError` を投げる。
 */
export function createEvidenceRecord<TType extends EvidenceType>(
  input: EvidenceRecordInput<TType>,
  context: EvidenceRecordContext,
): EvidenceRecordFor<TType> {
  const { type, pageId, viewport, payload } = input;
  if (!(EVIDENCE_TYPES as readonly unknown[]).includes(type)) {
    throw new RangeError('Evidence type must be one of EVIDENCE_TYPES');
  }
  if (typeof pageId !== 'string') {
    throw new RangeError('Evidence page ID must be a string');
  }
  if (viewport !== null && !(VIEWPORT_PROFILES as readonly unknown[]).includes(viewport)) {
    throw new RangeError('Evidence viewport must be one of VIEWPORT_PROFILES or null');
  }
  const observedAt = observedAtFrom(context.clock);
  const payloadCopy = structuredClone(payload);
  const evidenceId = context.allocator.allocateEvidenceId(type);
  return deepFreeze({ evidenceId, type, pageId, viewport, observedAt, payload: payloadCopy });
}

function observedAtFrom(clock: () => Date): string {
  if (typeof clock !== 'function') {
    throw new RangeError('Evidence clock must be a function');
  }
  const now: unknown = clock();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new RangeError('Evidence clock must return a valid Date');
  }
  return now.toISOString();
}
