/**
 * main frame の読み込みの観測の唯一の owner（サイトが応答しないときに Run を止める設計書 2.1）。BeakSight が自分で始める main frame の
 * 読み込み（Passive のナビゲーション、幅の走査、Interaction の候補の読み込み、robots.txt と sitemap.xml の取得）は、待ち方
 * （`domcontentloaded`、`load`、期限の競争）が違う。その終わり方を、同じ形の観測（`MainFrameLoadObservation`）にそろえる。
 * 観測を作るのは、この部品だけにする。
 *
 * この部品は判定をしない（サイトの不調かは、`src/orchestration/site-availability.ts` だけが決める）。
 */
import type { Page, Request, Response } from 'playwright';
import type { DeadlineOutcome } from '../core/deadline.js';
import { safeErrorMessage } from '../core/errors.js';
import type { NavigationOutcomeKind } from '../core/evidence-types.js';
import { MAX_ERROR_MESSAGE_LENGTH } from '../core/limits.js';
import { isPlaywrightTimeoutError } from './playwright-errors.js';

/**
 * 観測の結果の種類。
 * - `OK`: 読み込みが終わった（4xx・5xx も `OK`）。
 * - `TIMEOUT`: Playwright の期限切れ（`isPlaywrightTimeoutError`）か、期限の競争（`awaitBeforeDeadline`）の `DEADLINE_EXCEEDED`。
 * - `FAILED`: それ以外の失敗。Guard が遮断した外部へのリダイレクトも、観測では `FAILED` になる。
 */
export type MainFrameLoadOutcome = Extract<NavigationOutcomeKind, 'OK' | 'TIMEOUT' | 'FAILED'>;

/** main frame の読み込みの観測（設計書 2.1）。凍結して返す。 */
export interface MainFrameLoadObservation {
  readonly navigationOutcome: MainFrameLoadOutcome;
  /**
   * main frame の最後のナビゲーションの要求の応答の HTTP の status。応答（ヘッダ）を受けていなければ `null`。
   * 読み込みが終わった場合は `page.goto` の応答の status（応答が `null` なら、追跡の値）。時間切れと失敗の場合は、追跡の値。
   */
  readonly httpStatus: number | null;
  /**
   * 失敗の、上限（`MAX_ERROR_MESSAGE_LENGTH`）付きのメッセージ。`OK` なら `null`。期限の競争で時間切れになった場合
   * （例外がない）も `null`。
   */
  readonly failureDetail: string | null;
}

/**
 * 読み込みの終わり方（閉じた形）。期限の競争の結果（`awaitBeforeDeadline` の `DeadlineOutcome`）と同じ形にし、期限の競争で待った読み込みは、
 * その結果をそのまま渡す。Playwright の期限だけで待った読み込みは、`page.goto` の応答を `FULFILLED`、例外を `REJECTED` にして渡す。
 * - `FULFILLED`: 読み込みが終わった。`value` は `page.goto` の応答（`Response | null`）。
 * - `REJECTED`: 読み込みが例外で終わった。`reason` は例外。
 * - `DEADLINE_EXCEEDED`: 期限の競争で時間切れになった（例外はない）。
 */
export type MainFrameLoadSettlement = DeadlineOutcome<Response | null>;

/**
 * main frame の最後の文書の要求の応答の追跡。読み込みを始める前に付け、観測を作った後に外す。判定はしない。
 */
export interface MainFrameDocumentTracker {
  /** main frame の最後のナビゲーションの要求の応答の status。最後の要求に応答（ヘッダ）を受けていなければ `null`。 */
  latestResponseStatus(): number | null;
  /** page の要求と応答の事象の受け口を外す。外した後は、値が変わらない。何度呼んでもよい。 */
  dispose(): void;
}

/**
 * page の要求と応答の事象で、main frame の最後の文書の要求の応答の status を追う（設計書 2.1）。
 * - main frame のナビゲーションの要求（`isNavigationRequest()` が真で、`frame()` が `page.mainFrame()`）を受けたら、それを最後の要求にし、
 *   status を `null` に戻す（リダイレクトでは、新しい要求が来たら、前の応答を忘れる）。
 * - 最後の要求への応答を受けたら、その status を覚える。ほかの要求（iframe、画像など）の応答は見ない。
 * - `frame()` が例外を投げる要求（service worker の要求など）は無視する。
 */
export function trackMainFrameDocument(page: Page): MainFrameDocumentTracker {
  let latestRequest: Request | null = null;
  let latestStatus: number | null = null;
  let disposed = false;

  const onRequest = (request: Request): void => {
    if (isMainFrameNavigationRequest(page, request)) {
      latestRequest = request;
      latestStatus = null;
    }
  };
  const onResponse = (response: Response): void => {
    if (latestRequest !== null && response.request() === latestRequest) {
      latestStatus = response.status();
    }
  };
  page.on('request', onRequest);
  page.on('response', onResponse);

  return Object.freeze({
    latestResponseStatus: (): number | null => latestStatus,
    dispose: (): void => {
      if (disposed) {
        return;
      }
      disposed = true;
      page.off('request', onRequest);
      page.off('response', onResponse);
    },
  });
}

/**
 * 追跡と読み込みの終わり方から、観測を作る（設計書 2.1）。
 * - `FULFILLED`: `OK`。`httpStatus` は応答の status（応答が `null` なら追跡の値）。
 * - `DEADLINE_EXCEEDED`: `TIMEOUT`。`httpStatus` は追跡の値。`failureDetail` は `null`。
 * - `REJECTED`: `isPlaywrightTimeoutError` なら `TIMEOUT`、ほかは `FAILED`。`httpStatus` は追跡の値。
 *   `failureDetail` は `safeErrorMessage(reason, MAX_ERROR_MESSAGE_LENGTH)`。
 */
export function observeMainFrameLoad(
  tracker: MainFrameDocumentTracker,
  settlement: MainFrameLoadSettlement,
): MainFrameLoadObservation {
  switch (settlement.status) {
    case 'FULFILLED': {
      const response = settlement.value;
      return observation('OK', response === null ? tracker.latestResponseStatus() : response.status(), null);
    }
    case 'DEADLINE_EXCEEDED':
      return observation('TIMEOUT', tracker.latestResponseStatus(), null);
    case 'REJECTED':
      return observation(
        isPlaywrightTimeoutError(settlement.reason) ? 'TIMEOUT' : 'FAILED',
        tracker.latestResponseStatus(),
        safeErrorMessage(settlement.reason, MAX_ERROR_MESSAGE_LENGTH),
      );
  }
}

/** main frame のナビゲーションの要求か。`frame()` などが例外を投げる要求（service worker の要求など）は、偽とする。 */
function isMainFrameNavigationRequest(page: Page, request: Request): boolean {
  try {
    return request.isNavigationRequest() && request.frame() === page.mainFrame();
  } catch {
    return false;
  }
}

const observation = (
  navigationOutcome: MainFrameLoadOutcome,
  httpStatus: number | null,
  failureDetail: string | null,
): MainFrameLoadObservation => Object.freeze({ navigationOutcome, httpStatus, failureDetail });
