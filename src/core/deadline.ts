import { isPositiveSafeInteger } from './guards.js';

/**
 * 絶対時刻の期限までに操作が終わったかを、例外を投げずに表す結果。
 * 期限切れのときは、元の操作の値や拒否理由を持たない。
 */
export type DeadlineOutcome<T> =
  | Readonly<{ status: 'FULFILLED'; value: T }>
  | Readonly<{ status: 'REJECTED'; reason: unknown }>
  | Readonly<{ status: 'DEADLINE_EXCEEDED' }>;

// Node.js の setTimeout が受け付ける最大の遅延。これを超えると 1ms に丸められる。
const MAX_TIMER_DELAY_MS = 2_147_483_647;

const DEADLINE_EXCEEDED: DeadlineOutcome<never> = Object.freeze({ status: 'DEADLINE_EXCEEDED' });

type SettledOutcome<T> = Exclude<DeadlineOutcome<T>, { readonly status: 'DEADLINE_EXCEEDED' }>;

/**
 * `operation` を、絶対時刻 `deadlineAtMs`（`Date.now()` の値）まで待つ。
 *
 * - 期限の前に完了すれば `FULFILLED`、拒否されれば `REJECTED` を返す。例外は投げない。
 * - 呼び出し時点で期限を過ぎている場合と、完了を確かめた時点で期限を過ぎている場合は `DEADLINE_EXCEEDED` を返す。
 * - 期限が有限の数でない場合は、期限を過ぎたものとして扱う（fail-closed）。
 * - `operation` には必ず rejection handler を付けるので、期限切れの後に拒否されても unhandledRejection にならない。
 * - 期限のタイマーは、結果が決まった時点で解除する。
 */
export async function awaitBeforeDeadline<T>(
  operation: PromiseLike<T>,
  deadlineAtMs: number,
): Promise<DeadlineOutcome<T>> {
  const settled = Promise.resolve(operation).then<SettledOutcome<T>, SettledOutcome<T>>(
    (value) => Object.freeze({ status: 'FULFILLED', value }),
    (reason: unknown) => Object.freeze({ status: 'REJECTED', reason }),
  );
  if (!Number.isFinite(deadlineAtMs) || deadlineAtMs - Date.now() <= 0) {
    return DEADLINE_EXCEEDED;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadlineReached = new Promise<typeof DEADLINE_EXCEEDED>((resolve) => {
    const arm = (): void => {
      const remainingMs = deadlineAtMs - Date.now();
      const clamped = remainingMs > MAX_TIMER_DELAY_MS;
      timer = setTimeout(() => {
        if (clamped && Date.now() < deadlineAtMs) {
          arm();
          return;
        }
        resolve(DEADLINE_EXCEEDED);
      }, clamped ? MAX_TIMER_DELAY_MS : remainingMs);
    };
    arm();
  });

  try {
    const result = await Promise.race([settled, deadlineReached]);
    if (result === DEADLINE_EXCEEDED || Date.now() >= deadlineAtMs) {
      return DEADLINE_EXCEEDED;
    }
    return result;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * 注入された待つ時間の上限（ms）を検証して返す。`value` が `undefined` なら `defaultMs`（`limits.ts` の定数など）を返す。
 * 正の安全な整数でなければ `RangeError` を投げる。期限を注入できる部品（Context、page、Browser を閉じる処理と、作成の期限など）が
 * 共通に使う（期限の値の検証は、ここだけで行う。P18e）。`defaultMs` は検証しない（呼び出し側が定義元の定数を渡す）。
 */
export function resolveTimeoutMs(value: number | undefined, defaultMs: number): number {
  if (value === undefined) {
    return defaultMs;
  }
  if (!isPositiveSafeInteger(value)) {
    throw new RangeError('A timeout must be a positive safe integer of milliseconds');
  }
  return value;
}

/** `delayMs` ミリ秒の後に解決する。 */
export function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/** マクロタスクを1回譲る。先に予約された遅延0のタイマーが実行されてから解決する。 */
export async function yieldMacrotask(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
