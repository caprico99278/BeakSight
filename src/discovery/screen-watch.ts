// L6/L3-1（設計書 `2026-11-09-beaksight-remove-limits-design.md` 5 の 1、6 の L3・L6）: 操作さがしの 1 画面の見張り。ブラウザの部品
// （`tests/architecture/discovery-boundary.test.ts` の `BROWSER_DISCOVERY_FILES`）。
// - 1 画面の発見と押す輪を、1 つの進みの見張り（L0 の `watchProgress`）で包む（`watchDiscoveryScreen`）。ページの通信と画面の変化の印は
//   `attachPageProgressSignals` が付ける。
// - 見張りの口は、page ごとに置く（`screenWatchOf`）。この画面の中の読み取りと押す操作（isolated world の読み取り・JS の結び付きの読み取り・Playwright の
//   1 手）は、口があれば `trackOnScreen` を通す（ブラウザからの応答を進みとみなす）。口を多くの関数の引数に回さないため、page を鍵にする。
// - 入れ子の部品（`watchedPageRead`・選んだ後の落ち着きの待ち）は、口があれば自分では見張らず、その口を使う。
// - 見張りが画面を終えたら（全く反応がない・静まらない）、口の `signal` は abort する。見放した処理は、`screenWatchEnded` を見て、押す前に止まる。
//   page に残る口は終えたままにする（見放した処理が、後から押さないように）。
// この見張りは BeakSight 自身の処理の守りで、網羅の上限ではない。
// - ページの画面の変化の見回り（`attachPageProgressSignals` の isolated world の読み取り）は、BeakSight の段の中身の進みではない。見回りの読み取りは
//   `pageChangePollerReads` の中で動かし、CDP の命令の印（`cdp-session.ts`）を付けない（付けると、見回りが続くだけで画面を終えず、押す 1 手が返らない
//   ときに待ち続ける）。
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Page } from 'playwright';
import { attachPageProgressSignals } from '../browser/page-progress-signals.js';
import { watchProgress, type ProgressSignals, type WatchedOutcome } from '../core/progress-watch.js';

const screenWatches = new WeakMap<Page, ProgressSignals>();
/** 1 画面の見張りの反応なしの長さ（指定したときだけ。子の見張り（落ち着きの待ち）に同じ長さを渡す）。 */
const screenWatchQuietLimits = new WeakMap<Page, number>();

/** この page の 1 画面の見張りの反応なしの長さ（見張りの外か、指定がなければ `undefined`。`undefined` は `PROGRESS_WATCH_QUIET_LIMIT_MS`）。 */
export const screenWatchQuietLimitOf = (page: Page): number | undefined => screenWatches.has(page) ? screenWatchQuietLimits.get(page) : undefined;

/** 画面の変化の見回りの読み取り（この中で始めた非同期の処理は、BeakSight の段の進みに数えない）。 */
const pageChangePollerReads = new AsyncLocalStorage<true>();

/** この page の 1 画面の見張りの口（見張りの外なら `undefined`）。 */
export const screenWatchOf = (page: Page): ProgressSignals | undefined => screenWatches.get(page);

/**
 * CDP の命令の印を付ける、この page の見張りの口（見張りの外か、画面の変化の見回りの読み取りの中なら `undefined`）。`cdp-session.ts` だけが使う。
 */
export const screenWatchForBrowserResponses = (page: Page): ProgressSignals | undefined =>
  pageChangePollerReads.getStore() === true ? undefined : screenWatches.get(page);

/** この page の 1 画面の見張りが、画面を終えたか（見張りの外なら偽）。 */
export const screenWatchEnded = (page: Page): boolean => screenWatches.get(page)?.signal.aborted === true;

/** ブラウザの呼び出しを、この page の見張りの口があれば `track` に通す（返ったら進みの印）。口がなければ、そのまま待つ。 */
export const trackOnScreen = <T>(page: Page, call: PromiseLike<T>): Promise<T> => {
  const signals = screenWatches.get(page);
  return signals === undefined ? Promise.resolve(call) : signals.track(call);
};

/** 1 画面の見張りの指定（テストが反応なしの長さを短くする。省略は `PROGRESS_WATCH_QUIET_LIMIT_MS`）。 */
export interface ScreenWatchOptions {
  readonly quietLimitMs?: number | undefined;
}

/**
 * 1 画面の発見と押す輪（`work`）を、1 つの進みの見張りで包む（例外を投げない。結果は `watchProgress` の形）。見張りの間、page に口を置く。
 */
export async function watchDiscoveryScreen<T>(
  page: Page,
  work: (signals: ProgressSignals) => Promise<T>,
  options: ScreenWatchOptions = {},
): Promise<WatchedOutcome<T>> {
  return watchProgress(async (signals) => {
    // 見張りが画面を終えたら（abort）、印の受け口は `attachPageProgressSignals` が自分で外す。
    const detach = pageChangePollerReads.run(true, () => attachPageProgressSignals(page, signals));
    screenWatches.set(page, signals);
    if (options.quietLimitMs === undefined) {
      screenWatchQuietLimits.delete(page);
    } else {
      screenWatchQuietLimits.set(page, options.quietLimitMs);
    }
    try {
      return await work(signals);
    } finally {
      detach();
      // 画面を終えずに終わったときだけ口を外す（終えたときは、見放した処理が後から押さないように、終えた口を残す）。
      if (!signals.signal.aborted && screenWatches.get(page) === signals) screenWatches.delete(page);
    }
  }, { quietLimitMs: options.quietLimitMs });
}
