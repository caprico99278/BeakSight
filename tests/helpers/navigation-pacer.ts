import type { AuditConfig } from '../../src/config/types.js';
import { wait } from '../../src/core/deadline.js';
import { createNavigationPacer, type NavigationPacer } from '../../src/crawl/navigation-pacer.js';

/**
 * 設定から、本番と同じ形の、ページの読み込みの間隔を守る部品を作る（L2、L2-fix-round-1。サイトへの負荷の制御の設計書 4.1）。
 * 間隔は設定の `crawl.minNavigationIntervalMs`（`createTestConfig` では 0）、時刻は実際の時刻（`Date.now()`）、待ちは
 * `src/core/deadline.ts` の `wait` である。本番では Run Coordinator が Run の初めに1つ作って渡す。Run Coordinator を通さずに
 * Page Auditor などを動かすテストで、その代わりに使う（同じ式をテストのファイルごとに書かない）。
 */
export function createTestNavigationPacer(config: AuditConfig): NavigationPacer {
  return createNavigationPacer({ minIntervalMs: config.crawl.minNavigationIntervalMs, now: () => Date.now(), sleep: wait });
}

/**
 * 待たない、ページの読み込みの間隔の待ち（RL-fix。RL の Minor-5。CC-038）。幅の走査や metadata の取得の間隔の待ちは省略できないので、
 * 間隔を確かめないテストは、待たないことを、この関数で明示して渡す。待った時間（ms）として 0 を返す。
 */
export const NO_PACING_WAIT = async (): Promise<number> => 0;

/**
 * T44 P1-5: 待たない、幅の走査の読み込みの後の落ち着きの待ち（`StressLayoutOptions.settleBeforeLayout`）。省略できないので、待ちを確かめないテストは、
 * 待たないことを、この関数で明示して渡す。
 */
export const NO_SETTLING_WAIT = async (): Promise<void> => undefined;

/**
 * `pacer` の読み込みの開始の待ち（`beforeNavigation`）だけを `beforeNavigation` に差し替え、ほかの操作（記録の写し、間隔の引き上げ、
 * 送った時刻の記録）は `pacer` にそのまま渡す pacer（DEF-100 fix。テストが開始の時刻や呼び出しの順を記録するための包み）。送った時刻の記録は、
 * `pacer` に渡す前に `onDocumentRequestSent` を呼ぶ（テストが送った時刻を記録するため）。
 * 送った時刻の記録（`recordDocumentRequestSent`）を渡し忘れると、届く間隔の保証がテストの中だけ外れるので、包みはこの関数で作る。
 */
export function forwardingNavigationPacer(
  pacer: NavigationPacer,
  beforeNavigation: () => Promise<number>,
  onDocumentRequestSent: () => void = () => undefined,
): NavigationPacer {
  return {
    beforeNavigation,
    snapshot: () => pacer.snapshot(),
    raiseMinimumInterval: (minIntervalMs) => pacer.raiseMinimumInterval(minIntervalMs),
    // 受け口を先に呼ぶ（受け口が読む時刻は、pacer が記録する時刻以下になる）。
    recordDocumentRequestSent: () => {
      onDocumentRequestSent();
      pacer.recordDocumentRequestSent();
    },
  };
}
