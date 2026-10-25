/**
 * `route.abort('blockedbyclient')` で BeakSight が止めた要求の失敗の理由の閉じた一覧と、その判定の唯一の置き場所（L4、CCX-2、CC-035）。
 * BN-c の fix（発見事項 1。設計書 `2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md` 6.1.8 の「レポートは Playwright を読み込まない」）:
 * 純粋な定数と関数なので、Playwright を import しない `src/core/` に置いた（前は `src/browser/playwright-errors.ts`。呼び出し側はここを直接 import する）。
 * 表示の側（`src/report/**`）は、ここを読む。
 */

/**
 * `route.abort('blockedbyclient')` で止めた文書の要求（main frame と iframe のナビゲーション）の失敗の理由。下の一覧
 * `BLOCKED_BY_CLIENT_FAILURE_TEXTS` の先頭の値（CCX-2。CC-035）。Guard が自分で止めた文書の要求の失敗の照合は、この値を使う
 * （Guard に文字列を直書きしない）。
 */
export const BLOCKED_BY_CLIENT_DOCUMENT_FAILURE_TEXT = 'net::ERR_BLOCKED_BY_CLIENT';

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
  BLOCKED_BY_CLIENT_DOCUMENT_FAILURE_TEXT,
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
