/**
 * 時計（RB-8。再構築の設計書 2 章 4。RB-2 の判断で、使う段がここに置く）。今の時刻（ms と Date）と、待つ関数の組。
 * - 部品は、差し込まれた時計を使い、なければ本物の時計（`SYSTEM_CLOCK`）を使う。差し込めるのはテストだけで、本番の入口は渡さない。
 * - テストの偽の時計（`tests/helpers/fake-browser-port/fake-clock.ts`）は、この形に、時刻を進める口を足したもの。
 */
import { wait } from './deadline.js';

export interface Clock {
  now(): number;
  date(): Date;
  sleep(ms: number): Promise<void>;
}

/** 本物の時計。 */
export const SYSTEM_CLOCK: Clock = Object.freeze({
  now: (): number => Date.now(),
  date: (): Date => new Date(),
  sleep: (ms: number): Promise<void> => wait(ms),
});
