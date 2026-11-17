// L0 進みの見張り（設計書 `2026-11-09-beaksight-remove-limits-design.md` 5 の 1）の、ページの自発の変化の印を付ける部品。見張り（`src/core/progress-watch.ts`）の
// 口（`ProgressSignals`）に、次の印を付ける。ページに何もしない（読み込みを足さない・押さない）。
// - ページの通信（`PAGE_NETWORK`）: Playwright の page の要求の事象（`request`・`response`・`requestfinished`・`requestfailed`）を受けるたび。
// - 画面の変化（`DOM_CHANGE`）: isolated world（`src/discovery/isolated-read.ts` の `readInIsolatedWorld`。ページの JS からは見えない）に DOM の変化を
//   数える MutationObserver を置き、間隔（`PAGE_PROGRESS_DOM_POLL_INTERVAL_MS`）ごとに数を読む。数が変わっていれば印を付ける。読み取りが返っただけでは
//   印を付けない（段の中身の進みではない）。ページの main thread が止まっていると読み取りが返らないので、印が付かない（固まったページは「応答しなかった」に
//   なる）。数え始めの読み取り（文書が変わった後の 1 回目を含む）は、変化に数えない。
// - 見張りが段を終えたら（`signal` の abort）、または `detach` を呼んだら、事象の受け口を外し、読み取りを止める。
import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright';
import { wait } from '../core/deadline.js';
import { PRODUCTION_OBSERVATION_WINDOWS } from '../core/observation-windows.js';
import { PROGRESS_WATCH_QUIET_LIMIT_MS, type ProgressSignals } from '../core/progress-watch.js';
import { readInIsolatedWorld } from '../discovery/isolated-read.js';

/** 画面の変化の数を読む間隔（ms。RB-2: 観察の窓の一式の `watch.domPollIntervalMs`）。 */
export const PAGE_PROGRESS_DOM_POLL_INTERVAL_MS = PRODUCTION_OBSERVATION_WINDOWS.watch.domPollIntervalMs;

/** page の要求の事象（どれも、ページの通信の印）。 */
const PAGE_NETWORK_EVENTS = Object.freeze(['request', 'response', 'requestfinished', 'requestfailed'] as const);

export interface PageProgressSignalOptions {
  /** 画面の変化の数を読む間隔（ms）。省略すると `PAGE_PROGRESS_DOM_POLL_INTERVAL_MS`。 */
  readonly domPollIntervalMs?: number | undefined;
  /** 1 回の読み取りを待つ上限（ms）。止まったページで読み取りを繰り返さないための自分の待ち。省略すると `PROGRESS_WATCH_QUIET_LIMIT_MS`。 */
  readonly domReadTimeoutMs?: number | undefined;
}

/**
 * isolated world で、DOM の変化の数を返す（ページの中で動く。外の値を参照しない）。初めて呼ばれた文書では、MutationObserver を `key` の名前の global に置く。
 * 文書が変わると isolated world も新しくなるので、数は 0 から数え直す。
 */
const readMutationCountInPage = (key: string): number => {
  const holder = globalThis as unknown as Record<string, { count: number } | undefined>;
  let state = holder[key];
  if (state === undefined) {
    const created = { count: 0 };
    new MutationObserver((records) => {
      created.count += records.length;
    }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    holder[key] = created;
    state = created;
  }
  return state.count;
};

/**
 * `page` のページの自発の変化（通信と画面の変化）の印を、`signals` に付け始める。戻り値は、外す関数（何度呼んでもよい）。
 */
export function attachPageProgressSignals(
  page: Page,
  signals: Pick<ProgressSignals, 'mark' | 'signal'>,
  options: PageProgressSignalOptions = {},
): () => void {
  const pollIntervalMs = options.domPollIntervalMs ?? PAGE_PROGRESS_DOM_POLL_INTERVAL_MS;
  const readTimeoutMs = options.domReadTimeoutMs ?? PROGRESS_WATCH_QUIET_LIMIT_MS;
  const key = `beaksight-progress-${randomUUID()}`;
  let detached = false;
  const onNetwork = (): void => signals.mark('PAGE_NETWORK');
  // 事象の名前ごとに型が違うので、受け口は `(name: string, listener) => void` の形で同じ関数を付け外しする。
  const on = page.on.bind(page) as (event: string, listener: () => void) => unknown;
  const off = page.off.bind(page) as (event: string, listener: () => void) => unknown;
  for (const event of PAGE_NETWORK_EVENTS) {
    on(event, onNetwork);
  }
  const detach = (): void => {
    if (detached) {
      return;
    }
    detached = true;
    signals.signal.removeEventListener('abort', detach);
    for (const event of PAGE_NETWORK_EVENTS) {
      off(event, onNetwork);
    }
  };
  signals.signal.addEventListener('abort', detach, { once: true });
  if (signals.signal.aborted) {
    detach();
    return detach;
  }
  const poll = async (): Promise<void> => {
    let previous: number | null = null;
    while (!detached && !page.isClosed()) {
      const read = await readInIsolatedWorld(page, readMutationCountInPage, key, Date.now() + readTimeoutMs);
      if (detached) {
        return;
      }
      const count = read.status === 'READ' && typeof read.value === 'number' ? read.value : null;
      if (count !== null && previous !== null && count !== previous) {
        signals.mark('DOM_CHANGE');
      }
      previous = count;
      await wait(pollIntervalMs);
    }
  };
  // 読み取りの失敗は印を付けないだけ（見張りが終わりを決める）。
  poll().catch(() => undefined);
  return detach;
}
