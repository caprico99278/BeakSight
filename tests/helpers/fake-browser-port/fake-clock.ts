/**
 * 偽の時計（RB-1。設計書 `2026-11-15-beaksight-test-rebuild-design.md` 2 章 4）。偽の口の待ち（期限切れ）と、偽の口で流す判定のテストの待ちを、
 * 本物の時間を待たずに進める。形は `now`・`date`・`sleep`（観察の窓の一式の時計と同じ形の案。RB-2）に、テストが進める `advance` を足したもの。
 * - `sleep(ms)` は、`advance` で時刻が `ms` 進むまで解決しない。
 * - `advance(ms)` は、期限の来た `sleep` を期限の順に解決し、そのたびに後続の処理を走らせてから、時刻を `ms` 先にする。
 * - RB-8: 形は製品の時計の型（`src/core/clock.ts` の `Clock`）に、`advance` などを足したもの。
 */
import type { Clock } from '../../../src/core/clock.js';

export interface FakeClock extends Clock {
  advance(ms: number): Promise<void>;
  /** まだ解決していない `sleep` の数。 */
  pendingSleepCount(): number;
}

interface PendingSleep {
  readonly dueAtMs: number;
  readonly order: number;
  readonly resolve: () => void;
}

/** 後続の処理（解決した Promise の続き）を走らせる。 */
const flushFollowUps = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export const createFakeClock = (startAtMs = 0): FakeClock => {
  let nowMs = startAtMs;
  let order = 0;
  const pending: PendingSleep[] = [];
  const nextDue = (): PendingSleep | undefined =>
    pending.reduce<PendingSleep | undefined>((first, sleep) =>
      (first === undefined || sleep.dueAtMs < first.dueAtMs || (sleep.dueAtMs === first.dueAtMs && sleep.order < first.order) ? sleep : first), undefined);
  return {
    now: () => nowMs,
    date: () => new Date(nowMs),
    sleep: (ms) => new Promise<void>((resolve) => {
      order += 1;
      pending.push({ dueAtMs: nowMs + ms, order, resolve });
    }),
    advance: async (ms) => {
      const targetMs = nowMs + ms;
      await flushFollowUps();
      for (let due = nextDue(); due !== undefined && due.dueAtMs <= targetMs; due = nextDue()) {
        pending.splice(pending.indexOf(due), 1);
        nowMs = due.dueAtMs;
        due.resolve();
        await flushFollowUps();
      }
      nowMs = targetMs;
    },
    pendingSleepCount: () => pending.length,
  };
};
