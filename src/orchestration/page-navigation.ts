import type { Page } from 'playwright';
import {
  observeMainFrameLoad,
  settleMainFrameLoad,
  trackMainFrameDocument,
  type MainFrameLoadObservation,
  type MainFrameLoadSettlement,
} from '../browser/main-frame-load.js';
import type { NavigationOutcomeKind, NormalizedHttpUrlEvidence } from '../core/evidence-types.js';
import { attachPageProgressSignals } from '../browser/page-progress-signals.js';
import { isPositiveSafeInteger } from '../core/guards.js';
import { PROGRESS_SIGNAL_KINDS, watchProgress } from '../core/progress-watch.js';
import { OPEN_ENDED_STAGE_MS } from './stage-deadline.js';
import { auditScopeLeftUrl } from './audit-scope-watch.js';
import { normalizeUrl } from '../crawl/normalize-url.js';
import { SafetyLedger } from '../safety/safety-ledger.js';

export interface PageNavigationOptions {
  /**
   * `page.goto` の期限（ミリ秒）。設定の `navigationTimeoutMs`、または段階の期限までの残り。正の安全な整数。
   * L14（設計書 `2026-11-09-beaksight-remove-limits-design.md` 6 の L14、表 A の T10）: `undefined`（利用者が期限を指定していない）なら期限を置かず、
   * 進みの見張り（`watchProgress`。ページの通信と画面の変化も進みに数える）で待つ。全く反応がなければ、時間切れ（`TIMEOUT`）の観測で返す。
   * 見放す印（`abandonSignal`）を渡したときは、呼び出し側が見張っているので、ここでは見張らない。
   */
  readonly timeoutMs: number | undefined;
  /** この page の Passive Context の Safety Ledger。遮断されたナビゲーションの増加で、`BLOCKED_EXTERNAL_REDIRECT` を判定する。 */
  readonly ledger: SafetyLedger;
  /** 最終URLの正規化に使う、残してよい query の名前（設定の `crawl.allowedQueryParameters`）。 */
  readonly allowedQueryParameters: ReadonlySet<string>;
  /**
   * L1（設計書 `2026-11-09-beaksight-remove-limits-design.md` 6 の L1）: 読み込みを見放す印（進みの見張りの `signal`。省略すると見放さない）。abort されたら、
   * 読み込みの終わりを待たずに、時間切れ（`TIMEOUT`。応答の status は追跡の値）の観測で返す（前の `timeoutMs` の時間切れと同じ形）。
   */
  readonly abandonSignal?: AbortSignal | undefined;
  /** L14: 期限なしで見張るときの反応なしの長さ（ms。テスト用。省略すると `PROGRESS_WATCH_QUIET_LIMIT_MS`）。 */
  readonly quietLimitMs?: number | undefined;
  /**
   * SD-2（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.4 の「main frame の文書の移動」）: URL が点検の範囲の外か（許可 Origin の外・読まないパス・
   * 読む範囲の外・危険な語。呼ぶ側が Run の範囲で作る）。Guard は main frame の移動を止めないので、読み込みの後の main frame の URL が範囲の外なら、その画面は点検しない
   * （結果は `BLOCKED_EXTERNAL_REDIRECT`。今の理由のコードの値を使い、意味は「点検の範囲の外へ移ったので点検しませんでした」）。省略は判定しない。
   */
  readonly isOutsideAuditScope?: ((url: string) => boolean) | undefined;
}

const ABANDONED_LOAD: MainFrameLoadSettlement = Object.freeze({ status: 'DEADLINE_EXCEEDED' });

/**
 * L14: 期限なしの読み込みを、進みの見張りで待つ（読み込みは通信と画面の変化そのものが進みなので、全部の印を中身の進みに数える。page-auditor の読み込みと同じ）。
 * 見張りが終えたら（全く反応がない）、時間切れの観測（`ABANDONED_LOAD`）で返す。読み込みの終わり方は reject しない。
 */
const settleWatched = async (
  page: Page,
  settle: (signal: AbortSignal) => Promise<MainFrameLoadSettlement>,
  quietLimitMs: number | undefined,
): Promise<MainFrameLoadSettlement> => {
  const watched = await watchProgress((signals) => {
    const detach = attachPageProgressSignals(page, signals);
    return settle(signals.signal).finally(detach);
  }, { contentKinds: PROGRESS_SIGNAL_KINDS, quietLimitMs });
  if (watched.status === 'REJECTED') {
    throw watched.reason;
  }
  return watched.status === 'FULFILLED' ? watched.value : ABANDONED_LOAD;
};

/** L1: 読み込みの終わり方を、見放す印と競わせる（abort されたら時間切れ）。読み込みの終わり方は reject しない。 */
const settleUnlessAbandoned = (settling: Promise<MainFrameLoadSettlement>, signal: AbortSignal | undefined): Promise<MainFrameLoadSettlement> => {
  if (signal === undefined) {
    return settling;
  }
  if (signal.aborted) {
    return Promise.resolve(ABANDONED_LOAD);
  }
  return Promise.race([
    settling,
    new Promise<MainFrameLoadSettlement>((resolve) => signal.addEventListener('abort', () => resolve(ABANDONED_LOAD), { once: true })),
  ]);
};

/** ナビゲーションの結果（Task 14〜17 の設計書 4.3.0、4.5.4）。凍結して返す。 */
export interface PageNavigationResult {
  readonly navigationOutcome: NavigationOutcomeKind;
  /** メインフレームの文書の応答の HTTP ステータス。`OK` 以外の場合と、応答を得られなかった場合は `null`。 */
  readonly httpStatus: number | null;
  /** `page.url()` を `normalizeUrl` で正規化した最終URL。正規化できない場合（例: `about:blank`、エラーページ）は `null`。 */
  readonly finalUrl: NormalizedHttpUrlEvidence | null;
  /** `OK` 以外の場合の失敗の詳細（LZ-2: 切り詰めない）。`OK` の場合は `null`。 */
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
 * - 観測が `FAILED` で、失敗の前後で、`ledger` の `blockedNavigations` の件数が増えた場合は `BLOCKED_EXTERNAL_REDIRECT`（ログインの段の Guard だけが止める）。
 * - SD-2: 観測が `OK` でも、読み込みの後の main frame の URL が点検の範囲の外（`isOutsideAuditScope`）なら `BLOCKED_EXTERNAL_REDIRECT`（その画面は点検しない）。
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
  if (timeoutMs !== undefined && !isPositiveSafeInteger(timeoutMs)) {
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
    const settle = (signal: AbortSignal | undefined): Promise<MainFrameLoadSettlement> => settleUnlessAbandoned(
      settleMainFrameLoad(page, url, { waitUntil: 'domcontentloaded', timeoutMs: timeoutMs ?? OPEN_ENDED_STAGE_MS }),
      signal,
    );
    loadObservation = observeMainFrameLoad(
      tracker,
      timeoutMs === undefined && options.abandonSignal === undefined
        ? await settleWatched(page, settle, options.quietLimitMs)
        : await settle(options.abandonSignal),
    );
  } finally {
    tracker.dispose();
  }
  // 観測の `FAILED` は、読み込みの間に Guard が外部へのナビゲーションを遮断していれば `BLOCKED_EXTERNAL_REDIRECT`、ほかは `FAILED`。
  // SD-2: 読み込めた画面の main frame の URL が点検の範囲の外なら（ページの script の移動・サーバのリダイレクト）、その画面は点検しない。判定は REV-SD の I-1 の
  // 部品（`auditScopeLeftUrl`）。URL を読めなければ外とする。
  const judge = options.isOutsideAuditScope;
  const currentUrl = currentUrlOf(page);
  const movedOutside = loadObservation.navigationOutcome === 'OK' && judge !== undefined
    && (currentUrl === '' || auditScopeLeftUrl(currentUrl, judge) !== null);
  const outcome: NavigationOutcomeKind = movedOutside || (loadObservation.navigationOutcome === 'FAILED'
    && blockedExternalNavigationCount(ledger) > blockedBefore)
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

/**
 * Guard が遮断したメインフレームのナビゲーションの件数。理由は `BLOCKED_NAVIGATION_REASONS`
 * （`EXTERNAL_MAIN_FRAME_NAVIGATION` だけ）なので、理由では絞り込まない。
 */
function blockedExternalNavigationCount(ledger: SafetyLedger): number {
  return ledger.snapshot().blockedNavigations.length;
}

/** page の main frame の今の URL（読めなければ空。空は範囲の判定で外になる）。 */
const currentUrlOf = (page: Page): string => {
  try {
    return page.url();
  } catch {
    return '';
  }
};

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
