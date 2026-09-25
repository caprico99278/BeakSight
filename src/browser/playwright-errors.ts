import { errors } from 'playwright';

/**
 * Playwright の期限切れの例外かを判定する（CC-017。判定はここだけで行う）。
 * 次のどちらかを満たせば、期限切れとする。
 * - Playwright の `errors.TimeoutError` の instance である。
 * - `Error` の instance で、`name` が `'TimeoutError'` である（Playwright の `TimeoutError` の `name` と同じ。
 *   Playwright の例外を別の realm や差し替えたオブジェクトから受け取った場合も、期限切れとして扱う）。
 *
 * 判定の途中で例外が起きた場合（例: `name` の getter や `instanceof` の検査が例外を投げる Proxy）は、期限切れではないとする。
 * この関数は例外を投げない。
 */
export function isPlaywrightTimeoutError(error: unknown): boolean {
  try {
    return error instanceof errors.TimeoutError || (error instanceof Error && error.name === 'TimeoutError');
  } catch {
    return false;
  }
}
