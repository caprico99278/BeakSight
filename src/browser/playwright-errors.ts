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

/**
 * `route.abort('blockedbyclient')` で止めた要求の、`requestfailed` の失敗の理由（`request.failure()?.errorText`）の閉じた一覧
 * （サイトへの負荷の制御の設計書 4.5。L4 の Blocker 2）。Guard と、リソースの届け方の部品が止めた要求は、ネットワークに送っていない。
 *
 * Chromium は、止めた要求の種類で違う理由を報告する（L4 の実装者が Playwright 1.62.1 の headless Chromium で確かめた）。
 * - 文書の要求（main frame と iframe のナビゲーション）: `net::ERR_BLOCKED_BY_CLIENT`
 * - 文書以外の要求（image、stylesheet、script、fetch、XHR、sendBeacon など）: `net::ERR_BLOCKED_BY_CLIENT.Inspector`
 *
 * 照合は完全一致で、前方一致にはしない（一覧にない理由は、止めた要求とみなさない。数える側、つまり多めに数える側に倒す）。
 */
export const BLOCKED_BY_CLIENT_FAILURE_TEXTS = Object.freeze([
  'net::ERR_BLOCKED_BY_CLIENT',
  'net::ERR_BLOCKED_BY_CLIENT.Inspector',
] as const);

const BLOCKED_BY_CLIENT_FAILURE_TEXT_SET: ReadonlySet<string> = new Set(BLOCKED_BY_CLIENT_FAILURE_TEXTS);

/**
 * 失敗の理由が、`route.abort('blockedbyclient')` で止めた要求の理由（`BLOCKED_BY_CLIENT_FAILURE_TEXTS` のどれか）と完全に一致するか。
 * 理由がない場合（`null`、`undefined`）は偽。この関数は例外を投げない。
 */
export function isBlockedByClientFailure(errorText: string | null | undefined): boolean {
  return typeof errorText === 'string' && BLOCKED_BY_CLIENT_FAILURE_TEXT_SET.has(errorText);
}
