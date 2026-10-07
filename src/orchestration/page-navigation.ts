import type { Page } from 'playwright';
import {
  observeMainFrameLoad,
  trackMainFrameDocument,
  type MainFrameLoadObservation,
  type MainFrameLoadSettlement,
} from '../browser/main-frame-load.js';
import type { NavigationOutcomeKind, NormalizedHttpUrlEvidence } from '../core/evidence-types.js';
import { isPositiveSafeInteger } from '../core/guards.js';
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
  /** メインフレームの文書の応答の HTTP ステータス。`OK` 以外の場合と、応答を得られなかった場合は `null`。 */
  readonly httpStatus: number | null;
  /** `page.url()` を `normalizeUrl` で正規化した最終URL。正規化できない場合（例: `about:blank`、エラーページ）は `null`。 */
  readonly finalUrl: NormalizedHttpUrlEvidence | null;
  /** `OK` 以外の場合の、上限（`MAX_ERROR_MESSAGE_LENGTH`）付きの失敗の詳細。`OK` の場合は `null`。 */
  readonly failureDetail: string | null;
  /**
   * main frame の読み込みの観測（サイトが応答しないときに Run を止める設計書 2.1。作るのは `observeMainFrameLoad`、
   * `src/browser/main-frame-load.ts`）。Page Auditor は、これで、サイトの不調を判定する（`siteUnavailabilityOf`）。
   * 上の3つの項目は、この観測から導く。観測は、時間切れと失敗の場合も、受けた応答の status を持つ。
   */
  readonly loadObservation: MainFrameLoadObservation;
}

/**
 * page を `url` へ `waitUntil: 'domcontentloaded'` でナビゲーションし、その結果の種類を返す（Task 14〜17 の設計書 4.5.4）。
 * 読み込みの前に main frame の最後の文書の追跡（`trackMainFrameDocument`）を付け、読み込みの後に観測（`observeMainFrameLoad`）を作り、
 * 結果の `loadObservation` に持たせる（サイトが応答しないときに Run を止める設計書 2.1）。結果の種類は、観測から導く。
 * - 観測が `OK`（応答を得た。4xx・5xx も `OK`。判定は Rule が行う）なら `OK`。`httpStatus` は観測の値（`page.goto` が応答なしで
 *   解決した場合は、追跡の値。なければ `null`）。
 * - 観測が `TIMEOUT`（Playwright の期限切れ。分け方は観測の部品だけが持つ）なら `TIMEOUT`。
 * - 観測が `FAILED` で、失敗の前後で、`ledger` の `blockedNavigations` の件数が増えた場合は `BLOCKED_EXTERNAL_REDIRECT`。
 *   Ledger の記録が上限（`blockedNavigations` の件数の上限）に達していると増加を観測できず、`FAILED` になる。
 * - それ以外の失敗は `FAILED`。
 * - `OK` 以外の場合、`httpStatus` は `null`。`failureDetail` は、観測の失敗の詳細。
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
  const tracker = trackMainFrameDocument(page);
  let loadObservation: MainFrameLoadObservation;
  try {
    loadObservation = observeMainFrameLoad(tracker, await settleNavigation(page, url, timeoutMs));
  } finally {
    tracker.dispose();
  }
  // 観測の `FAILED` は、読み込みの間に Guard が外部へのナビゲーションを遮断していれば `BLOCKED_EXTERNAL_REDIRECT`、ほかは `FAILED`。
  const outcome: NavigationOutcomeKind = loadObservation.navigationOutcome === 'FAILED'
    && blockedExternalNavigationCount(ledger) > blockedBefore
    ? 'BLOCKED_EXTERNAL_REDIRECT'
    : loadObservation.navigationOutcome;
  return Object.freeze({
    navigationOutcome: outcome,
    httpStatus: outcome === 'OK' ? loadObservation.httpStatus : null,
    finalUrl: normalizedFinalUrl(page, url, allowedQueryParameters),
    failureDetail: loadObservation.failureDetail,
    loadObservation,
  });
}

/** `page.goto` の終わり方（読み込みが終わったら応答、例外なら例外。Playwright の期限だけで待つ）。例外を投げない。 */
async function settleNavigation(page: Page, url: string, timeoutMs: number): Promise<MainFrameLoadSettlement> {
  try {
    return { status: 'FULFILLED', value: await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs }) };
  } catch (error) {
    return { status: 'REJECTED', reason: error };
  }
}

/**
 * Guard が遮断したメインフレームのナビゲーションの件数。理由は `BLOCKED_NAVIGATION_REASONS`
 * （`EXTERNAL_MAIN_FRAME_NAVIGATION` だけ）なので、理由では絞り込まない。
 */
function blockedExternalNavigationCount(ledger: SafetyLedger): number {
  return ledger.snapshot().blockedNavigations.length;
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

/** Chromium のネットワークのエラーのコード（例: `net::ERR_CONNECTION_REFUSED`）の形。 */
const CHROMIUM_NET_ERROR_CODE_PATTERN = /\bnet::ERR_[A-Z0-9]+(?:_[A-Z0-9]+)*/u;

/** `FAILED` の detail の、結果の種類とエラーのコードの区切り（`FAILED:<Chromium のエラーのコード>`）。 */
const NAVIGATION_FAILURE_DETAIL_SEPARATOR = ':';

/**
 * ナビゲーションの失敗の詳細（`navigatePage` の `failureDetail`）から、Chromium のネットワークのエラーのコードを取り出す
 * （Task 14〜17 の設計書 5.6.4）。最初に現れたコードを返す。コードがない場合は `null`。取り出す処理は、ここだけで行う。
 */
export function chromiumNetErrorCode(failureDetail: string | null): string | null {
  if (typeof failureDetail !== 'string') {
    return null;
  }
  return CHROMIUM_NET_ERROR_CODE_PATTERN.exec(failureDetail)?.[0] ?? null;
}

/**
 * ナビゲーションが失敗したときの理由（`NAVIGATION_FAILED`）の `detail`（Task 14〜17 の設計書 4.5.4、5.6.4）。
 * - 期限切れ: `TIMEOUT`
 * - 外部へのリダイレクトの遮断: `BLOCKED_EXTERNAL_REDIRECT`
 * - そのほかの失敗: `FAILED:<Chromium のエラーのコード>`（例: `FAILED:net::ERR_CONNECTION_RESET`）。コードがない場合は `FAILED`。
 *
 * Run Coordinator は、この detail で再試行するかを判断する。`OK` は失敗ではないので `RangeError` を投げる。
 */
export function navigationFailureDetail(
  navigation: Pick<PageNavigationResult, 'navigationOutcome' | 'failureDetail'>,
): string {
  const { navigationOutcome } = navigation;
  if (navigationOutcome === 'OK') {
    throw new RangeError('navigation failure detail needs a failed navigation outcome');
  }
  if (navigationOutcome !== 'FAILED') {
    return navigationOutcome;
  }
  const code = chromiumNetErrorCode(navigation.failureDetail);
  return code === null ? navigationOutcome : `${navigationOutcome}${NAVIGATION_FAILURE_DETAIL_SEPARATOR}${code}`;
}
