import { isNonNegativeFiniteNumber } from '../core/guards.js';

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
