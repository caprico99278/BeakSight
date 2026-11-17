// L2（設計書 `2026-11-09-beaksight-remove-limits-design.md` 5 の 1・6 の L2）: collector の中のブラウザの読み取りを、L0 の進みの見張り
// （`src/core/progress-watch.ts` の `watchProgress`）で包む部品（collector の唯一の入口）。
// - 期限を置かない。ブラウザの呼び出しが返るたびに中身の進みの印を付け（`signals.track`）、ページの自発の変化（通信・画面の変化）の印は
//   `attachPageProgressSignals` が付ける。全く反応がない（`STAGE_UNRESPONSIVE`）・静まらない（`STAGE_NEVER_QUIET`）ときだけ、読み取りを見放して
//   終わりを返す。進む間は何分でも待つ。axe のように 1 回の呼び出しが長い読み取りも、L0 の反応なしの長さ（`PROGRESS_WATCH_QUIET_LIMIT_MS`。3 分）で受ける。
// - 集めた記録は、collector が自分の入れ物に入れておく（見張りが終えても残る）。
// - L1b（見張りは 1 つだけ）: 呼ぶ側の段の見張りの口（`progress`）を渡すと、collector は自分では見張らず、その口だけを使う（印はその口に付け、その口の
//   `signal` が abort したら、待っているブラウザの呼び出しを見放して `ENDED` を返す）。終えるのは呼ぶ側の見張りだけで、理由は abort の理由から読む
//   （`progressWatchEndOf`）。abort の後、collector は待たずに（同じ回りのうちに）それまでの記録を返すので、呼ぶ側はその記録を受け取れる。
import type { Page } from 'playwright';
import { attachPageProgressSignals } from './page-progress-signals.js';
import { progressWatchEndOf, watchProgress, type ProgressSignals, type ProgressWatchEnd } from '../core/progress-watch.js';

/**
 * collector の見張りが読み取りを終えた理由（collector の記録の理由の値）。Run の時間の上限（`RUN_TIME_LIMIT`。呼ぶ側の見張りだけが持つ）は、期限を
 * 過ぎた（`DEADLINE_EXCEEDED`）とする。
 */
export type CollectorWatchEnd = 'STAGE_UNRESPONSIVE' | 'STAGE_NEVER_QUIET' | 'DEADLINE_EXCEEDED';

/** collector の見張りの指定。 */
export interface CollectorWatchOptions {
  /** 反応なしの長さ（ms）。省略は `PROGRESS_WATCH_QUIET_LIMIT_MS`（テストが短くする）。呼ぶ側の口を渡したときは使わない。 */
  readonly quietLimitMs?: number | undefined;
  /** L1b: 呼ぶ側の段の見張りの口。渡すと、collector は自分では見張らず、この口だけを使う。 */
  readonly progress?: ProgressSignals | undefined;
}

/** `watchCollection` の部品の側の指定。 */
interface CollectorWatchParts {
  /**
   * ページの自発の変化の印（`attachPageProgressSignals`）を付けるか（省略は付ける）。ページの外の読み取り（CDP の session を開く処理など）で、ページの
   * 読み取りの session を足したくない部品は、偽にする（ブラウザからの応答の印だけで見張る）。呼ぶ側の口を使うときは、呼ぶ側が付ける。
   */
  readonly pageSignals?: boolean | undefined;
}

/** 見張った読み取りの結果（例外を投げない）。 */
export type CollectorWatchOutcome<T> =
  | Readonly<{ status: 'FULFILLED'; value: T }>
  | Readonly<{ status: 'REJECTED'; reason: unknown }>
  | Readonly<{ status: 'ENDED'; end: CollectorWatchEnd }>;

const collectorEndOf = (end: ProgressWatchEnd | null): CollectorWatchEnd => {
  switch (end) {
    case 'STAGE_NEVER_QUIET':
      return 'STAGE_NEVER_QUIET';
    case 'RUN_TIME_LIMIT':
      return 'DEADLINE_EXCEEDED';
    default:
      return 'STAGE_UNRESPONSIVE';
  }
};

const ended = <T>(end: CollectorWatchEnd): CollectorWatchOutcome<T> => Object.freeze({ status: 'ENDED', end });

/** 見張りが abort したことを表す（呼ぶ側の口の abort で、待っている呼び出しを見放す印）。 */
const WATCH_ABORTED = Symbol('watch aborted');

/**
 * `page` の読み取り（`work`）を、進みの見張りで包む。`work` には進みの印の口を渡す（ブラウザの呼び出しは `signals.track` で待つ）。
 * 全く反応がない・静まらないときだけ `ENDED` を返す（`work` は見放す。`signals.signal` が abort するので、繰り返しは止められる）。
 */
export async function watchCollection<T>(
  page: Page,
  work: (signals: ProgressSignals) => Promise<T>,
  options: CollectorWatchOptions = {},
  parts: CollectorWatchParts = {},
): Promise<CollectorWatchOutcome<T>> {
  const caller = options.progress;
  if (caller !== undefined) {
    return watchWithCaller(caller, work);
  }
  const pageSignals = parts.pageSignals ?? true;
  const outcome = await watchProgress(async (signals) => {
    const detach = pageSignals ? attachPageProgressSignals(page, signals) : (): void => undefined;
    try {
      return await work(signals);
    } finally {
      detach();
    }
  }, { quietLimitMs: options.quietLimitMs });
  return outcome.status === 'ENDED' ? ended(collectorEndOf(outcome.end)) : outcome;
}

/** L1b: 呼ぶ側の口だけで見張る。口の abort で、待っている呼び出しを見放し（同じ回りのうちに）、`ENDED` を返す。 */
async function watchWithCaller<T>(caller: ProgressSignals, work: (signals: ProgressSignals) => Promise<T>): Promise<CollectorWatchOutcome<T>> {
  const endNow = (): CollectorWatchOutcome<T> => ended(collectorEndOf(progressWatchEndOf(caller.signal)));
  if (caller.signal.aborted) {
    return endNow();
  }
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = (): void => reject(WATCH_ABORTED);
  });
  aborted.catch(() => undefined);
  caller.signal.addEventListener('abort', onAbort, { once: true });
  const signals: ProgressSignals = Object.freeze({
    signal: caller.signal,
    mark: caller.mark,
    track: <U>(call: PromiseLike<U>): Promise<U> => Promise.race([caller.track(call), aborted]),
  });
  try {
    return Object.freeze({ status: 'FULFILLED', value: await Promise.race([work(signals), aborted]) });
  } catch (reason) {
    return caller.signal.aborted ? endNow() : Object.freeze({ status: 'REJECTED', reason });
  } finally {
    caller.signal.removeEventListener('abort', onAbort);
  }
}
