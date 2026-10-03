import type { Page } from 'playwright';
import { isPlaywrightTimeoutError } from '../browser/playwright-errors.js';
import type { NavigationOutcomeKind, NormalizedHttpUrlEvidence } from '../core/evidence-types.js';
import { safeErrorMessage } from '../core/errors.js';
import { isPositiveSafeInteger } from '../core/guards.js';
import { MAX_ERROR_MESSAGE_LENGTH } from '../core/limits.js';
import { normalizeUrl } from '../crawl/normalize-url.js';
import { SafetyLedger } from '../safety/safety-ledger.js';

export interface PageNavigationOptions {
  /** `page.goto` の期限（ミリ秒）。設定の `navigationTimeoutMs`、または段階の期限までの残り。正の安全な整数。 */
  readonly timeoutMs: number;
  /** この page の Passive Context の Safety Ledger。遮断されたナビゲーションの増加で、`BLOCKED_EXTERNAL_REDIRECT` を判定する。 */
  readonly ledger: SafetyLedger;
  /** 最終URLの正規化に使う、残してよい query の名前（設定の `crawl.allowedQueryParameters`）。 */
  readonly allowedQueryParameters: ReadonlySet<string>;
}

/** ナビゲーションの結果（Task 14〜17 の設計書 4.3.0、4.5.4）。凍結して返す。 */
export interface PageNavigationResult {
  readonly navigationOutcome: NavigationOutcomeKind;
  /** メインフレームの文書の応答の HTTP ステータス。応答を得られなかった場合は `null`。 */
  readonly httpStatus: number | null;
  /** `page.url()` を `normalizeUrl` で正規化した最終URL。正規化できない場合（例: `about:blank`、エラーページ）は `null`。 */
  readonly finalUrl: NormalizedHttpUrlEvidence | null;
  /** `OK` 以外の場合の、上限（`MAX_ERROR_MESSAGE_LENGTH`）付きの失敗の詳細。`OK` の場合は `null`。 */
  readonly failureDetail: string | null;
}

/**
 * page を `url` へ `waitUntil: 'domcontentloaded'` でナビゲーションし、その結果の種類を返す（Task 14〜17 の設計書 4.5.4）。
 * - 応答を得た場合は `OK`（4xx・5xx も `OK`。判定は Rule が行う）。`page.goto` が応答なしで解決した場合も `OK` で、
 *   `httpStatus` は `null`。
 * - Playwright の期限切れは `TIMEOUT`。
 * - 失敗の前後で、`ledger` の `blockedNavigations` の件数が増えた場合は `BLOCKED_EXTERNAL_REDIRECT`。
 *   Ledger の記録が上限（`blockedNavigations` の件数の上限）に達していると増加を観測できず、`FAILED` になる。
 * - それ以外の失敗は `FAILED`。
 *
 * ナビゲーションの失敗では例外を投げない。例外を投げる（reject する）のは、引数が不正な場合だけで、そのときは
 * ナビゲーションしない。
 */
export async function navigatePage(page: Page, url: string, options: PageNavigationOptions): Promise<PageNavigationResult> {
  if (typeof url !== 'string') {
    throw new TypeError('Navigation URL must be a string');
  }
  const { timeoutMs, ledger, allowedQueryParameters } = options;
  if (!isPositiveSafeInteger(timeoutMs)) {
    throw new RangeError('Navigation timeout must be a positive safe integer');
  }
  if (!(ledger instanceof SafetyLedger)) {
    throw new TypeError('Navigation requires the Safety Ledger of the Passive Context');
  }
  if (!(allowedQueryParameters instanceof Set)) {
    throw new TypeError('Allowed query parameters must be a Set');
  }

  const blockedBefore = blockedExternalNavigationCount(ledger);
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    return result('OK', response === null ? null : response.status(), page, url, allowedQueryParameters, null);
  } catch (error) {
    const outcome: NavigationOutcomeKind = isPlaywrightTimeoutError(error)
      ? 'TIMEOUT'
      : blockedExternalNavigationCount(ledger) > blockedBefore
        ? 'BLOCKED_EXTERNAL_REDIRECT'
        : 'FAILED';
    const failureDetail = safeErrorMessage(error, MAX_ERROR_MESSAGE_LENGTH);
    return result(outcome, null, page, url, allowedQueryParameters, failureDetail);
  }
}

/**
 * Guard が遮断したメインフレームのナビゲーションの件数。理由は `BLOCKED_NAVIGATION_REASONS`
 * （`EXTERNAL_MAIN_FRAME_NAVIGATION` だけ）なので、理由では絞り込まない。
 */
function blockedExternalNavigationCount(ledger: SafetyLedger): number {
  return ledger.snapshot().blockedNavigations.length;
}

function result(
  navigationOutcome: NavigationOutcomeKind,
  httpStatus: number | null,
  page: Page,
  requestedUrl: string,
  allowedQueryParameters: ReadonlySet<string>,
  failureDetail: string | null,
): PageNavigationResult {
  return Object.freeze({
    navigationOutcome,
    httpStatus,
    finalUrl: normalizedFinalUrl(page, requestedUrl, allowedQueryParameters),
    failureDetail,
  });
}

function normalizedFinalUrl(
  page: Page,
  requestedUrl: string,
  allowedQueryParameters: ReadonlySet<string>,
): NormalizedHttpUrlEvidence | null {
  let currentUrl: string;
  try {
    currentUrl = page.url();
  } catch {
    return null;
  }
  const normalized = normalizeUrl(currentUrl, requestedUrl, allowedQueryParameters);
  return normalized.ok ? normalized.url : null;
}
