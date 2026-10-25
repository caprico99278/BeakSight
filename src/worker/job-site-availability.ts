/**
 * 発見と READ の確かめのジョブの、サイトの不調の扱い（DEF-136。設計書 `doc/design/2026-10-18-beaksight-job-site-unavailability-design.md` の 3.1・3.2）。
 * 発見のジョブ（`discovery-run.ts`）と READ の確かめのジョブ（`read-check-run.ts`）が共有する。不調の判定は、読み取りの監査と同じ唯一の owner
 * （`src/orchestration/site-availability.ts` の `siteUnavailabilityOf`）に任せ、ここで複製しない。
 *
 * 1. 読み込みの判定（`pageLoadVerdictOf`）: 1 つの画面の読み込みの結果（`PageNavigationResult`。`loadObservation` を持つ）を、不調 → 読み込みの失敗 →
 *    エラーの状態（4xx・5xx。不調の 4 つの状態を除く）→ 読める、の順に判定する。セッションの切れは、読み込みの部品（`visitGuardedPage`）が、この判定の
 *    前に見分ける（判定の順は、セッションの切れ → 不調 → エラーの状態）。
 * 2. 確かめ直し（`createJobSiteRecheck`）: 不調なら、その画面の結果を捨て、知らせ（`SITE_UNAVAILABLE_RECHECK`。1 回だけ）を出してから、読み取りの監査の
 *    最初の待ち（`JOB_SITE_UNAVAILABLE_RECHECK_DELAY_MS`。テストは注入で短くする）だけ待ち、同じ画面を 1 回だけ確かめ直す。待つ前か待つ間に止める印が
 *    来たら、確かめ直さずに止める（`STOPPED`）。まだ不調なら止める（`SITE_UNAVAILABLE`）。通ったら続け、読み込みの最小の間隔を、読み取りの監査と同じ
 *    規則（`slowedNavigationIntervalMs`。2 倍、上限は設定の 8 倍）で上げ、知らせ（`SITE_UNAVAILABLE_SLOWDOWN`）を出す。
 * 待つ間は、サイトへ何も送らない（読み込みの部品も pacer も呼ばない）。
 */
import { ERROR_HTTP_STATUS_RANGE, isHttpStatusInRange } from '../core/http-status.js';
import { wait } from '../core/deadline.js';
import type { NavigationPacer } from '../crawl/navigation-pacer.js';
import type { PageNavigationResult } from '../orchestration/page-navigation.js';
import type { RunNotice } from '../orchestration/run-coordinator.js';
import {
  SITE_UNAVAILABLE_RECHECK_DELAYS_MS,
  siteUnavailabilityOf,
  sleepUnlessStopped,
  slowedNavigationIntervalMs,
  type SiteUnavailability,
} from '../orchestration/site-availability.js';

/** 確かめ直しの前の待ち（ms。読み取りの監査の最初の待ちと同じ名前つきの定数。ジョブは 4 段の待ちを使わず、この 1 回だけ）。 */
export const JOB_SITE_UNAVAILABLE_RECHECK_DELAY_MS: number = SITE_UNAVAILABLE_RECHECK_DELAYS_MS[0] ?? 60_000;

/** ジョブが 1 つの画面を確かめ直す回数（1 回だけ）。 */
const JOB_SITE_UNAVAILABLE_MAX_RECHECKS = 1;

/** ジョブの、実行中の知らせ（読み取りの監査と同じ形。ワーカーの流れが `NOTICE` で親へ送り、ジョブの画面に出る）。 */
export type JobSiteNotice = Extract<RunNotice, { readonly kind: 'SITE_UNAVAILABLE_RECHECK' | 'SITE_UNAVAILABLE_SLOWDOWN' }>;

/**
 * 発見と READ の確かめのジョブの、実行中の知らせのすべて（DEF-141）。サイトの不調の知らせ（`JobSiteNotice`）と、承認したサービスの Origin への要求の
 * 1 分あたりの上限で次の読み込みの前に待つ知らせ（`SERVICE_REQUEST_PACING_WAIT`）。読み取りの監査と同じ形。
 */
export type JobRunNotice = JobSiteNotice | Extract<RunNotice, { readonly kind: 'SERVICE_REQUEST_PACING_WAIT' }>;

/** 1 つの画面の読み込みの判定。 */
export type PageLoadVerdict =
  | { readonly kind: 'READABLE' }
  | { readonly kind: 'SITE_UNAVAILABLE'; readonly unavailability: SiteUnavailability }
  | { readonly kind: 'NAVIGATION_FAILED' }
  | { readonly kind: 'HTTP_ERROR_STATUS'; readonly httpStatus: number };

const READABLE: PageLoadVerdict = Object.freeze({ kind: 'READABLE' });
const NAVIGATION_FAILED: PageLoadVerdict = Object.freeze({ kind: 'NAVIGATION_FAILED' });

/** 1 つの画面の読み込みの判定（ファイルの先頭の 1。不調 → 読み込みの失敗 → エラーの状態 → 読める）。 */
export function pageLoadVerdictOf(navigation: PageNavigationResult): PageLoadVerdict {
  const unavailability = siteUnavailabilityOf(navigation.loadObservation);
  if (unavailability !== null) {
    return Object.freeze({ kind: 'SITE_UNAVAILABLE', unavailability });
  }
  if (navigation.navigationOutcome !== 'OK') {
    return NAVIGATION_FAILED;
  }
  const { httpStatus } = navigation;
  return httpStatus !== null && isHttpStatusInRange(httpStatus, ERROR_HTTP_STATUS_RANGE)
    ? Object.freeze({ kind: 'HTTP_ERROR_STATUS', httpStatus })
    : READABLE;
}

/** 確かめ直しの指定。 */
export interface JobSiteRecheckOptions {
  /** 確かめ直しの前の待ち（ms。本番は `JOB_SITE_UNAVAILABLE_RECHECK_DELAY_MS`）。 */
  readonly delayMs: number;
  /** 止める印（待ちを打ち切り、確かめ直さない）。 */
  readonly stopSignal: AbortSignal;
  /** ジョブの読み込みの間隔を守る部品（通ったら最小の間隔を上げる）。 */
  readonly pacer: NavigationPacer;
  /** 設定の読み込みの最小の間隔（ms。減速の上限の元）。 */
  readonly configuredMinIntervalMs: number;
  readonly onNotice?: ((notice: JobSiteNotice) => void) | undefined;
  /** 待つ部品（省略すると本物の待ち。テストが注入する）。 */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

/** 確かめ直しの結果（どれも、最後の読み込みの値を持つ）。 */
export type JobSiteVisit<T> =
  | { readonly kind: 'DONE'; readonly value: T }
  | { readonly kind: 'SITE_UNAVAILABLE'; readonly value: T }
  | { readonly kind: 'STOPPED'; readonly value: T };

/** ジョブの確かめ直しの部品（1 つのジョブで 1 つ。読み込みの最小の間隔の今の値を持つ）。 */
export interface JobSiteRecheck {
  /**
   * 1 つの画面を読み込む（`visitOnce`）。結果が不調（`isUnavailable`）なら、ファイルの先頭の 2 のとおり 1 回だけ確かめ直す。`url` は知らせに載せる
   * 画面の URL。
   */
  visit<T>(url: string, visitOnce: () => Promise<T>, isUnavailable: (value: T) => boolean): Promise<JobSiteVisit<T>>;
}

/** ジョブの確かめ直しの部品を作る（ファイルの先頭の 2）。 */
export function createJobSiteRecheck(options: JobSiteRecheckOptions): JobSiteRecheck {
  const sleep = options.sleep ?? wait;
  let minIntervalMs = options.configuredMinIntervalMs;
  const notify = (notice: JobSiteNotice): void => options.onNotice?.(Object.freeze(notice));
  return {
    async visit<T>(url: string, visitOnce: () => Promise<T>, isUnavailable: (value: T) => boolean): Promise<JobSiteVisit<T>> {
      const first = await visitOnce();
      if (!isUnavailable(first)) {
        return { kind: 'DONE', value: first };
      }
      if (options.stopSignal.aborted) {
        return { kind: 'STOPPED', value: first };
      }
      notify({ kind: 'SITE_UNAVAILABLE_RECHECK', url, delayMs: options.delayMs, attempt: 1, maxAttempts: JOB_SITE_UNAVAILABLE_MAX_RECHECKS });
      await sleepUnlessStopped(sleep, options.delayMs, options.stopSignal);
      if (options.stopSignal.aborted) {
        return { kind: 'STOPPED', value: first };
      }
      const second = await visitOnce();
      if (isUnavailable(second)) {
        return { kind: 'SITE_UNAVAILABLE', value: second };
      }
      // 通った。読み込みの最小の間隔を、読み取りの監査と同じ規則で上げる（上限なら上げず、知らせも出さない）。
      const raisedMs = slowedNavigationIntervalMs(minIntervalMs, options.configuredMinIntervalMs);
      if (raisedMs > minIntervalMs) {
        minIntervalMs = raisedMs;
        options.pacer.raiseMinimumInterval(raisedMs);
        notify({ kind: 'SITE_UNAVAILABLE_SLOWDOWN', minIntervalMs: raisedMs });
      }
      return { kind: 'DONE', value: second };
    },
  };
}
