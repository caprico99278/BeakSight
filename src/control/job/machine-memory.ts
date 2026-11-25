// 端末の空きメモリでの受け入れ（PAR-b。設計書 `2026-11-17-beaksight-parallel-site-audits-design.md` 2 章の「端末の負荷」）の唯一の owner。
// - 同時に流す数の上限は置かない。ジョブの管理は、動いているジョブが 1 つ以上あるときだけ、新しいジョブを始める前に `hasMemoryForAnotherJob` で
//   確かめる（1 本目と、連鎖の次の段・自動ログインのし直しは確かめない）。
// - 線は「全体の 30%（使用率 70% の線）＋ 1 本分」。1 本分（`AUDIT_JOB_MEMORY_BYTES`）は名前つきの定数で、この 1 か所だけ。
// - 読み取り（`readMachineMemory`）は本番の入口の既定。テストは、ジョブの管理の依存の注入（`machineMemory`）で値を差し込む（端末の値を待たない）。
import { freemem, totalmem } from 'node:os';

/**
 * 1 本の点検が使うメモリの見込み（bytes）。2026-11-17 の実環境の Run の測り（作業用の node 約 405MB、Chromium 約 980MB）からの仮の値（約 1.4GB）。
 * 最初に実環境で同時に流すときに、1 本の最大を測って直す。
 */
export const AUDIT_JOB_MEMORY_BYTES = 1_400 * 1024 * 1024;

/** 空けておく割合（全体に対して。使用率 70% の線）。 */
const RESERVED_FREE_MEMORY_RATIO = 0.3;

/** 端末のメモリ（bytes）。 */
export interface MachineMemory {
  readonly freeBytes: number;
  readonly totalBytes: number;
}

/** 端末の今の空きと全体（本番の入口の既定）。 */
export const readMachineMemory = (): MachineMemory => Object.freeze({ freeBytes: freemem(), totalBytes: totalmem() });

/** もう 1 本のジョブを始められる空きがあるか（空きが「全体の 30% ＋ 1 本分」以上）。 */
export const hasMemoryForAnotherJob = (memory: MachineMemory): boolean =>
  memory.freeBytes >= memory.totalBytes * RESERVED_FREE_MEMORY_RATIO + AUDIT_JOB_MEMORY_BYTES;
