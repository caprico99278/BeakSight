// L6/L3-1（設計書 `doc/design/2026-11-09-beaksight-remove-limits-design.md` 5 の 1）: 操作さがしの 1 画面の見張り（`src/discovery/screen-watch.ts`）の単体テスト。
// ブラウザを使わず、事象と CDP の session を真似た page で確かめる。
// - BeakSight 自身の読み取り（CDP の命令）が返るたびに、中身の進みに数える。
// - ページの画面の変化を見る読み取り（`attachPageProgressSignals` の見回り）は、中身の進みに数えない（見回りが続くだけで、画面を終えずに待ち続けない）。
import { EventEmitter } from 'node:events';
import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import { readInIsolatedWorld } from '../../src/discovery/isolated-read.js';
import { watchDiscoveryScreen } from '../../src/discovery/screen-watch.js';

/** 見張りの長さ（画面の変化の見回りの間隔 `PAGE_PROGRESS_DOM_POLL_INTERVAL_MS`（1 秒）より長くし、見回りが見張りの長さの中に何度も入るようにする）。 */
const QUIET_LIMIT_MS = 2_500;

/** CDP の session を真似た page（isolated world の読み取りは、呼ぶたびに違う数を返す。画面が変わり続ける形）。 */
const fakePage = (): Page => {
  const emitter = new EventEmitter();
  let count = 0;
  const session = {
    send: (method: string): Promise<Record<string, unknown>> => {
      if (method === 'Page.getFrameTree') return Promise.resolve({ frameTree: { frame: { id: 'main' } } });
      if (method === 'Page.createIsolatedWorld') return Promise.resolve({ executionContextId: 1 });
      count += 1;
      return Promise.resolve({ result: { value: count } });
    },
    detach: (): Promise<void> => Promise.resolve(),
  };
  return Object.assign(emitter, {
    isClosed: () => false,
    context: () => ({ newCDPSession: () => Promise.resolve(session) }),
  }) as unknown as Page;
};

describe('L6/L3-1: the progress watch of one discovery screen', () => {
  it('ends a screen whose work never returns, although the page-change poller keeps reading', async () => {
    const page = fakePage();
    const startedAt = Date.now();
    const outcome = await watchDiscoveryScreen(page, () => new Promise<never>(() => undefined), { quietLimitMs: QUIET_LIMIT_MS });
    expect(outcome.status).toBe('ENDED');
    expect(Date.now() - startedAt).toBeLessThan(QUIET_LIMIT_MS * 3);
  }, 30_000);

  it('counts the reads of BeakSight itself as progress while the work keeps reading', async () => {
    const page = fakePage();
    const reads = 6;
    const outcome = await watchDiscoveryScreen(page, async () => {
      // 1 回の読み取りの間を見張りの長さの半分にし、合わせて見張りの長さの 2 倍より長く続ける。
      for (let at = 0; at < reads; at += 1) {
        await wait(QUIET_LIMIT_MS / 2);
        await readInIsolatedWorld(page, () => 1, null, Date.now() + 60_000);
      }
      return 'DONE';
    }, { quietLimitMs: QUIET_LIMIT_MS });
    expect(outcome).toEqual({ status: 'FULFILLED', value: 'DONE' });
  }, 30_000);
});
