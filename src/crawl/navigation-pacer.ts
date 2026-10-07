import { isNonNegativeSafeInteger, isRecord } from '../core/guards.js';

/**
 * 1回の `beforeNavigation()` で `sleep` を呼ぶ回数の上限（サイトへの負荷の制御の設計書 4.1、L2-fix-round-1）。
 * タイマーが早く発火した場合の待ち直しは、ふつう1回で足りる（1回目で届かなかった残りを、2回目で待つ）。3 にするのは、待ち直しが
 * もう1回早く終わった場合にも、間隔を守る余裕を残すためである。この回数に達したら、目標の時刻に届いていなくても待ちをやめる。
 * 時計が進まない場合（`now()` が同じ値を返し続ける場合）にも、`beforeNavigation()` が止まらなくなることはない。
 * 1回の `sleep` に渡す時間は `minIntervalMs` 以下なので、1回の呼び出しで待つ時間の合計は `MAX_SLEEPS_PER_NAVIGATION × minIntervalMs`
 * 以下になる（待っている途中で時計が戻った場合も。L2-fix-round-2）。
 */
export const MAX_SLEEPS_PER_NAVIGATION = 3;

/**
 * これまでの読み込みの記録（サイトへの負荷の制御の設計書 4.1、4.5）。`run.json` の負荷の記録と、再開のための保存に使う。
 * - `navigationCount`: `beforeNavigation()` が記録した読み込みの回数。
 * - `totalWaitMs`: 間隔のために待った時間の合計（ms）。
 * - `lastNavigationStartedAtMs`: 最後の読み込みの開始の時刻（エポックからの ms）。まだなければ `null`。
 */
export interface NavigationPacerSnapshot {
  readonly navigationCount: number;
  readonly totalWaitMs: number;
  readonly lastNavigationStartedAtMs: number | null;
}

/**
 * ページの読み込みの間隔を守る部品（サイトへの負荷の制御の設計書 3.1、4.1。この意味の owner）。
 * Run Coordinator が Run の初めに1つだけ作り、ページの読み込みを始めるすべての部品に渡す。ほかの部品は、読み込みの直前に
 * `beforeNavigation()` を呼ぶだけで、独自に待たない。
 */
export interface NavigationPacer {
  /**
   * 前の読み込みの開始から `minIntervalMs` 以上たつまで待ち、今回の読み込みの開始を記録する（待ちの上限は `createNavigationPacer` を参照）。
   * 待った時間（ms。0 以上の整数）を返す。呼び出し側は、待った時間を期限から除く（設計書 4.4）。
   */
  beforeNavigation(): Promise<number>;
  /** これまでの読み込みの回数、待った時間の合計、最後の読み込みの開始の時刻（凍結した値）。 */
  snapshot(): NavigationPacerSnapshot;
  /**
   * 最小の間隔を `minIntervalMs` に上げる（サイトが応答しないときに Run を止める設計書 3.6.2。確かめ直しで通った後の減速）。次の
   * `beforeNavigation()` から、新しい間隔で待つ（最後の読み込みの開始から数える）。今の間隔より大きくない値は無視する（下げない）。
   * 0 以上の安全な整数でなければ `RangeError` を投げる（間隔は変えない）。上げた間隔は記録（`snapshot`）に入れない（保存の形を変えない）。
   */
  raiseMinimumInterval(minIntervalMs: number): void;
}

/** `createNavigationPacer` の入力。 */
export interface NavigationPacerOptions {
  /** 読み込みの開始の最小の間隔（ms。0 以上の安全な整数。0 なら待たない）。設定の `crawl.minNavigationIntervalMs`。 */
  readonly minIntervalMs: number;
  /** 現在の時刻（エポックからの ms。0 以上の安全な整数）。本番では `Date.now()` と同じ基準の時刻。 */
  readonly now: () => number;
  /** `ms` ミリ秒待つ関数。本番では `src/core/deadline.ts` の `wait`。 */
  readonly sleep: (ms: number) => Promise<void>;
  /**
   * 再開のときに、前の回の記録を引き継ぐ（再開の設計書 4.9）。省略すると 0 から始める。
   * 再開の直後の最初の読み込みも、`lastNavigationStartedAtMs` から最小の間隔以上空ける。
   */
  readonly initial?: NavigationPacerSnapshot;
}

/**
 * `NavigationPacer` を作る（サイトへの負荷の制御の設計書 4.1）。
 *
 * - 1回目（最後の開始の時刻が `null`）は待たない。
 * - 待ちの目標の時刻は、`min(最後の開始 + minIntervalMs, 呼ばれた時刻 + minIntervalMs)` とする。時計が後ろに戻っても、1回の呼び出しで
 *   待つのは、呼ばれた時刻から数えて `minIntervalMs` までである。
 * - 呼ばれた時刻が目標より前なら、その差だけ `sleep` で待つ。待ちが早く終わり、まだ目標に届かない場合は、残りを待ち直す（タイマーが
 *   早く発火しても、間隔を下回らない）。1回の `sleep` に渡す時間は `minIntervalMs` 以下に切り詰める（待っている途中で時計が戻っても、
 *   1回の待ちが間隔より長くならない）。`sleep` を呼ぶのは `MAX_SLEEPS_PER_NAVIGATION` 回までとし、達したら目標に届いて
 *   いなくても待ちをやめる。待った後の `now()` を、今回の開始の時刻として記録する。待った時間は `max(0, 開始の時刻 − 呼ばれた時刻)`。
 * - `minIntervalMs` が 0 なら、`sleep` を呼ばない。
 * - 重ねて呼ばれた場合も、呼ばれた順に1つずつ処理する（前の呼び出しの完了を待つ鎖にする）。
 * - 待ちが失敗した（`sleep` が reject した）呼び出しは、読み込みとして記録しない。その失敗は、その呼び出しの reject になる。
 *
 * 不正な入力: `minIntervalMs` と `initial` の値が 0 以上の安全な整数でない（`lastNavigationStartedAtMs` は `null` も可）なら
 * `RangeError`、`now` と `sleep` が関数でない、`initial` がオブジェクトでないなら `TypeError` を投げる。
 * `now()` が 0 以上の安全な整数を返さない場合は、その呼び出しが `RangeError` で reject する（記録は変えない）。
 */
export function createNavigationPacer(options: NavigationPacerOptions): NavigationPacer {
  if (!isRecord(options)) {
    throw new TypeError('NavigationPacer options must be an object');
  }
  const { now, sleep, initial } = options;
  // 最小の間隔。`raiseMinimumInterval` で上がることがある（下がらない）。
  let minIntervalMs = options.minIntervalMs;
  if (!isNonNegativeSafeInteger(minIntervalMs)) {
    throw new RangeError('NavigationPacer minimum interval must be a non-negative safe integer of milliseconds');
  }
  if (typeof now !== 'function' || typeof sleep !== 'function') {
    throw new TypeError('NavigationPacer requires a current time function and a sleep function');
  }
  let state: NavigationPacerSnapshot = Object.freeze({ ...validatedInitial(initial) });
  // 前の呼び出しの完了（成功か失敗か）。次の呼び出しは、これを待ってから始める。
  let previous: Promise<unknown> = Promise.resolve();

  const currentTimeMs = (): number => {
    const value = now();
    if (!isNonNegativeSafeInteger(value)) {
      throw new RangeError('NavigationPacer current time must be a non-negative safe integer of milliseconds');
    }
    return value;
  };

  const pace = async (): Promise<number> => {
    const calledAtMs = currentTimeMs();
    let startedAtMs = calledAtMs;
    const { lastNavigationStartedAtMs } = state;
    if (minIntervalMs > 0 && lastNavigationStartedAtMs !== null) {
      // 時計が後ろに戻って、呼ばれた時刻が最後の開始より前になっても、呼ばれた時刻から `minIntervalMs` を超えて待たない。
      const targetStartAtMs = Math.min(lastNavigationStartedAtMs + minIntervalMs, calledAtMs + minIntervalMs);
      for (let sleepCount = 0; startedAtMs < targetStartAtMs && sleepCount < MAX_SLEEPS_PER_NAVIGATION; sleepCount += 1) {
        // 待っている途中で時計が戻ると、残りが `minIntervalMs` より長くなる。1回の待ちは `minIntervalMs` 以下に切り詰める
        // （L2-fix-round-2）。時計が戻らなければ、残りは `minIntervalMs` 以下なので、切り詰めは働かない。
        await sleep(Math.min(targetStartAtMs - startedAtMs, minIntervalMs));
        startedAtMs = currentTimeMs();
      }
    }
    const waitedMs = Math.max(0, startedAtMs - calledAtMs);
    state = Object.freeze({
      navigationCount: state.navigationCount + 1,
      totalWaitMs: state.totalWaitMs + waitedMs,
      lastNavigationStartedAtMs: startedAtMs,
    });
    return waitedMs;
  };

  return Object.freeze({
    beforeNavigation(): Promise<number> {
      const current = previous.then(pace);
      previous = current.catch(() => undefined);
      return current;
    },
    snapshot(): NavigationPacerSnapshot {
      return state;
    },
    raiseMinimumInterval(raisedMinIntervalMs: number): void {
      if (!isNonNegativeSafeInteger(raisedMinIntervalMs)) {
        throw new RangeError('NavigationPacer raised minimum interval must be a non-negative safe integer of milliseconds');
      }
      if (raisedMinIntervalMs > minIntervalMs) {
        minIntervalMs = raisedMinIntervalMs;
      }
    },
  });
}

/** 引き継ぐ記録を確かめる。省略した場合は、0 から始める記録を返す。 */
function validatedInitial(initial: NavigationPacerSnapshot | undefined): NavigationPacerSnapshot {
  if (initial === undefined) {
    return { navigationCount: 0, totalWaitMs: 0, lastNavigationStartedAtMs: null };
  }
  if (!isRecord(initial)) {
    throw new TypeError('NavigationPacer initial record must be an object');
  }
  const { navigationCount, totalWaitMs, lastNavigationStartedAtMs } = initial;
  if (
    !isNonNegativeSafeInteger(navigationCount)
    || !isNonNegativeSafeInteger(totalWaitMs)
    || (lastNavigationStartedAtMs !== null && !isNonNegativeSafeInteger(lastNavigationStartedAtMs))
  ) {
    throw new RangeError('NavigationPacer initial record values must be non-negative safe integers (the last start may be null)');
  }
  return { navigationCount, totalWaitMs, lastNavigationStartedAtMs };
}
