/**
 * サイトの不調の判定の唯一の owner（サイトが応答しないときに Run を止める設計書 2章、2.2）。BeakSight が自分で始めた main frame の
 * 読み込みの観測（`src/browser/main-frame-load.ts` の `MainFrameLoadObservation`）が、サイトの不調に当たるかを、ここだけで決める。
 * ほかの場所に同じ判定を書かない。
 *
 * 不調とみなすもの（閉じた一覧）:
 * 1. `TIMEOUT`: main frame の最後の文書の要求に、応答（ヘッダ）を1つも受けていない（`httpStatus` が `null`）なら `TIMEOUT` の不調。
 *    `httpStatus` が `SITE_UNAVAILABLE_HTTP_STATUSES` に入れば `HTTP_STATUS` の不調。
 * 2. `FAILED`: 失敗の詳細の最初の Chromium のエラーのコードが、閉じた一覧 `isNetworkLayerFailure`（`src/safety/network-layer-failure.ts`）に
 *    当たれば `NETWORK_FAILURE` の不調。当たらず、`httpStatus` が `SITE_UNAVAILABLE_HTTP_STATUSES` に入れば `HTTP_STATUS` の不調。
 * 3. `OK`: `httpStatus` が `SITE_UNAVAILABLE_HTTP_STATUSES` に入れば `HTTP_STATUS` の不調。
 *
 * 不調とみなさないもの: 応答を受けた後の時間切れ（本文や部品が遅い。status が一覧に入らない場合。設計書 2.2）、`OK` の 200・3xx・404・500 など、
 * `FAILED` の `net::ERR_ABORTED`（DEF-027 で別に扱う）・`net::ERR_FAILED`・`net::ERR_BLOCKED_BY_CLIENT`（Guard が遮断した外部への
 * リダイレクトを含む）、Chromium のエラーのコードがない `FAILED`（どれも、status が一覧に入らない場合）。
 *
 * 不調を検知した段階の閉じた一覧（`SITE_UNAVAILABILITY_STAGES`）と、理由とページの結果の `detail` の組み立て（`siteUnavailableStageDetail`、
 * `siteUnavailableDetail`）も、ここだけで行う（設計書 3.1、3.2）。不調を検知したため始めなかったものの理由（`SITE_UNAVAILABLE_SKIP_REASON`）も、
 * ここで公開する（Page Auditor と Run Coordinator が使う）。
 */
import type { MainFrameLoadObservation } from '../browser/main-frame-load.js';
import type { IncompleteReason, IncompleteReasonCode, ViewportProfile } from '../core/contracts.js';
import { isNetworkLayerFailure } from '../safety/network-layer-failure.js';
import { chromiumNetErrorCode, navigationFailureDetail } from './page-navigation.js';

/**
 * サイトの不調の種類の閉じた一覧。
 * - `TIMEOUT`: 読み込みの時間切れで、main frame の最後の文書の要求に、応答（ヘッダ）を受けていないもの。
 * - `NETWORK_FAILURE`: ネットワークの層の失敗（接続の拒否・リセット・失敗、名前解決の失敗、証明書の失敗など）。
 * - `HTTP_STATUS`: サイトが応答しないことを示す HTTP の status（`SITE_UNAVAILABLE_HTTP_STATUSES`）。
 */
export const SITE_UNAVAILABILITY_KINDS = Object.freeze(['TIMEOUT', 'NETWORK_FAILURE', 'HTTP_STATUS'] as const);
export type SiteUnavailabilityKind = (typeof SITE_UNAVAILABILITY_KINDS)[number];

/**
 * サイトの不調とみなす HTTP の status の閉じた一覧（設計書 2章）。500 は、そのページだけの不具合のことが多いので含めない。
 */
export const SITE_UNAVAILABLE_HTTP_STATUSES = Object.freeze([
  /** 429 Too Many Requests: サイトが、要求が多すぎると答えた（これ以上の読み込みを控えるべき合図）。 */
  429,
  /** 502 Bad Gateway: 中継のサーバが、その先のサーバから正しい応答を受け取れなかった。 */
  502,
  /** 503 Service Unavailable: メンテナンスや過負荷で、サーバが一時的に応答できない。 */
  503,
  /** 504 Gateway Timeout: 中継のサーバが、その先のサーバの応答を待ちきれなかった。 */
  504,
] as const);

const SITE_UNAVAILABLE_HTTP_STATUS_SET: ReadonlySet<number> = new Set(SITE_UNAVAILABLE_HTTP_STATUSES);

/** `HTTP_STATUS` の詳細の、status の前に付ける文字列（`HTTP <status>`。例: `HTTP 503`）。 */
const HTTP_STATUS_DETAIL_PREFIX = 'HTTP ';

/**
 * サイトの不調（種類と詳細）。詳細の形:
 * - `TIMEOUT`: `TIMEOUT`（`navigationFailureDetail` と同じ）。
 * - `NETWORK_FAILURE`: `FAILED:<Chromium のエラーのコード>`（`navigationFailureDetail` と同じ。例: `FAILED:net::ERR_CONNECTION_RESET`）。
 * - `HTTP_STATUS`: `HTTP <status>`（例: `HTTP 503`）。
 */
export interface SiteUnavailability {
  readonly kind: SiteUnavailabilityKind;
  readonly detail: string;
}

/**
 * main frame の読み込みの観測が、サイトの不調に当たるかを判定する（設計書 2章、2.2）。当たれば、凍結した種類と詳細を返し、当たらなければ
 * `null` を返す。時間切れとネットワークの層の失敗の詳細は `navigationFailureDetail` で作り、Chromium のエラーのコードは
 * `chromiumNetErrorCode` で取り出す（どちらも `src/orchestration/page-navigation.ts`。同じ形をほかに書かない）。
 */
export function siteUnavailabilityOf(observation: MainFrameLoadObservation): SiteUnavailability | null {
  switch (observation.navigationOutcome) {
    case 'TIMEOUT':
      return observation.httpStatus === null
        ? unavailability('TIMEOUT', navigationFailureDetail(observation))
        : httpStatusUnavailability(observation.httpStatus);
    case 'FAILED': {
      const code = chromiumNetErrorCode(observation.failureDetail);
      return code !== null && isNetworkLayerFailure(code)
        ? unavailability('NETWORK_FAILURE', navigationFailureDetail(observation))
        : httpStatusUnavailability(observation.httpStatus);
    }
    case 'OK':
      return httpStatusUnavailability(observation.httpStatus);
  }
}

/** main frame の最後の文書の応答の status が `SITE_UNAVAILABLE_HTTP_STATUSES` に入れば `HTTP_STATUS` の不調、そうでなければ `null`。 */
function httpStatusUnavailability(httpStatus: number | null): SiteUnavailability | null {
  return httpStatus !== null && SITE_UNAVAILABLE_HTTP_STATUS_SET.has(httpStatus)
    ? unavailability('HTTP_STATUS', `${HTTP_STATUS_DETAIL_PREFIX}${httpStatus}`)
    : null;
}

const unavailability = (kind: SiteUnavailabilityKind, detail: string): SiteUnavailability => Object.freeze({ kind, detail });

/**
 * サイトの不調を検知した段階の閉じた一覧（設計書 3.1）。
 * - `passive`: Passive の各ビューポートの読み込み（`navigatePage`）。
 * - `stress-layout`: 幅の走査の各幅の読み込み。
 * - `interaction`: Interaction の各候補の読み込み。
 * - `site-metadata`: robots.txt と sitemap.xml の取得（ビューポートはない）。
 */
export const SITE_UNAVAILABILITY_STAGES = Object.freeze(['passive', 'stress-layout', 'interaction', 'site-metadata'] as const);
export type SiteUnavailabilityStage = (typeof SITE_UNAVAILABILITY_STAGES)[number];

/** サイトの不調を表す理由のコード（設計書 3.1）。 */
const SITE_UNAVAILABLE_CODE: Extract<IncompleteReasonCode, 'SITE_UNAVAILABLE'> = 'SITE_UNAVAILABLE';

/**
 * サイトの不調を検知したため、始めなかったもの（同じページの次のビューポート。Run Coordinator では、始めなかったページ）の理由
 * （`detail` は `null`。設計書 3.1、3.2）。凍結する。コードは `SITE_UNAVAILABLE` に限った型にする（不調を検知したビューポートの理由
 * （`detail` は `siteUnavailableStageDetail`）と、段階を途中で止めた理由にも、このコードを使うため）。
 */
export const SITE_UNAVAILABLE_SKIP_REASON: IncompleteReason & { readonly code: typeof SITE_UNAVAILABLE_CODE; readonly detail: null } =
  Object.freeze({ code: SITE_UNAVAILABLE_CODE, detail: null });

/** 不調の `detail` の、ビューポート・段階・判定の詳細の区切り（`<ビューポート>:<段階>:<判定の詳細>`）。 */
const SITE_UNAVAILABLE_DETAIL_SEPARATOR = ':';

/**
 * 不調を検知したビューポートの理由（`SITE_UNAVAILABLE`）の `detail`。形は `<段階>:<判定の詳細>`（例: `passive:TIMEOUT`、
 * `stress-layout:HTTP 503`。設計書 3.1）。判定の詳細は `siteUnavailabilityOf` が返したもの。
 */
export function siteUnavailableStageDetail(stage: SiteUnavailabilityStage, unavailability: SiteUnavailability): string {
  return `${stage}${SITE_UNAVAILABLE_DETAIL_SEPARATOR}${unavailability.detail}`;
}

/**
 * ページの結果（`PageAuditOutcome.siteUnavailableDetail`）と、Run の理由（`SITE_UNAVAILABLE`）の `detail`（設計書 3.1、3.2）。
 * ビューポートがあれば `<ビューポート>:<段階>:<判定の詳細>`（例: `desktop:passive:TIMEOUT`）、なければ（robots.txt と sitemap.xml の取得）
 * `<段階>:<判定の詳細>`（例: `site-metadata:TIMEOUT`。ビューポートの理由の `detail` と同じ形）。
 */
export function siteUnavailableDetail(
  viewport: ViewportProfile | null,
  stage: SiteUnavailabilityStage,
  unavailability: SiteUnavailability,
): string {
  const stageDetail = siteUnavailableStageDetail(stage, unavailability);
  return viewport === null ? stageDetail : `${viewport}${SITE_UNAVAILABLE_DETAIL_SEPARATOR}${stageDetail}`;
}
