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
