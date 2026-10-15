/**
 * 件数の飽和の加算（CCX-2。CC-055、CC-067）。件数を安全な整数の上限（`Number.MAX_SAFE_INTEGER`）で止め、`RunStatusInput` などの
 * 検証を通る値に保つ。Safety Ledger と Guard は、これを使う（同じ意味の足し算を別に書かない）。
 */

/** `saturatingIncrement` が足す数（件数を 1 つ数える）。 */
const SINGLE_COUNT = 1;

/** 件数を足す。安全な整数の上限で止める。 */
export function saturatingAdd(count: number, increment: number): number {
  return Math.min(count + increment, Number.MAX_SAFE_INTEGER);
}

/** 件数を 1 増やす。安全な整数の上限で止める。 */
export function saturatingIncrement(count: number): number {
  return saturatingAdd(count, SINGLE_COUNT);
}
