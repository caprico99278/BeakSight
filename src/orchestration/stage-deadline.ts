import { isNonNegativeFiniteNumber } from '../core/guards.js';

/**
 * L1（設計書 `2026-11-09-beaksight-remove-limits-design.md` 6 の L1）: 期限を撤廃した段で、期限の数を必ず受け取る部品（Playwright の `timeout`、collector の
 * `deadlineAtMs` など）に渡す長さ（ms）。Node.js の `setTimeout` が受け付ける最大の遅延（約 24.8 日）で、実際には切らない値。段を終えるのは、進みの見張り
 * （`src/core/progress-watch.ts`）と、利用者の Run の時間の上限だけ。
 */
export const OPEN_ENDED_STAGE_MS = 2_147_483_647;

/**
 * L1: 期限を撤廃した段の、期限の数（`Date.now()` と同じ基準）。今から `OPEN_ENDED_STAGE_MS` 後と、Run の時間の上限（`runDeadlineAtMs`。上限なしは
 * 省略。LZ-1 で番兵の `Infinity` をやめた）の早い方。期限の数を必ず受け取る部品に渡すためだけに使う（計算はここだけで行う）。
 */
export function openEndedStageDeadline(nowMs: number, runDeadlineAtMs?: number): number {
  if (!Number.isFinite(nowMs)) {
    throw new RangeError('current time must be a finite number');
  }
  const openEndedAtMs = nowMs + OPEN_ENDED_STAGE_MS;
  return runDeadlineAtMs === undefined ? openEndedAtMs : Math.min(openEndedAtMs, runDeadlineAtMs);
}

/**
 * L6/L3-1: 期限を置かない読み取りの、期限の数（今から。Run の時間の上限は見ない）。期限の数を必ず受け取る読み取りの部品に渡す（操作さがしの読み取り・
 * 押す部品）。固まった画面は、進みの見張り（操作さがしでは 1 画面の見張り `src/discovery/screen-watch.ts`）が終える。唯一の置き場所。
 */
export const openReadDeadline = (): number => openEndedStageDeadline(Date.now());

/**
 * ページの監査の、ある段階の期限（`Date.now()` と同じ基準の絶対時刻）を返す（Task 14〜17 の設計書 4.5.7）。
 * ページの期限と「現在の時刻 + 段階の予算」の、早い方とする。段階に独自の予算がない（`null`）場合は、ページの期限を返す。
 * ページの期限がすでに過ぎていても、そのまま返す（期限切れの扱いは呼び出し側が決める）。
 *
 * 段階の予算の値（`navigationTimeoutMs`、`resourceSettlingTimeoutMs`、その倍数）は、呼び出し側が設定と
 * `src/core/limits.ts` から決める。この関数は、期限の計算だけを1か所で行う。
 *
 * 引数が有限の数でない場合、予算が負の場合、「現在の時刻 + 段階の予算」が有限でない場合は、`RangeError` を投げる。
 */
export function stageDeadline(pageDeadlineAtMs: number, nowMs: number, stageBudgetMs: number | null): number {
  if (!Number.isFinite(pageDeadlineAtMs)) {
    throw new RangeError('page deadline must be a finite number');
  }
  if (!Number.isFinite(nowMs)) {
    throw new RangeError('current time must be a finite number');
  }
  if (stageBudgetMs === null) {
    return pageDeadlineAtMs;
  }
  if (!isNonNegativeFiniteNumber(stageBudgetMs)) {
    throw new RangeError('stage budget must be null or a non-negative finite number');
  }
  const stageDeadlineAtMs = nowMs + stageBudgetMs;
  if (!Number.isFinite(stageDeadlineAtMs)) {
    throw new RangeError('stage deadline must be a finite number');
  }
  return Math.min(pageDeadlineAtMs, stageDeadlineAtMs);
}
