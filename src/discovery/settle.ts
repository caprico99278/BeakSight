// 発見の前の、落ち着きの待ち（Task 27 の設計書 4.2。T27b）。ブラウザの部品（`tests/architecture/discovery-boundary.test.ts` の
// `BROWSER_DISCOVERY_FILES`）。
// - 条件: 「進行中の要求が 0 の状態が `DISCOVERY_NETWORK_QUIET_MS` 続く」かつ「2 回続けて同じ候補の集合（識別の digest の集合）」。上限
//   `DISCOVERY_SETTLE_TIMEOUT_MS` を超えたら `TIMED_OUT`（呼ぶ側が `INCOMPLETE_SETTLE_TIMEOUT` にする）。
// - 2 回の読み取りを組にするのは、1 回目の読み取りの前から 2 回目の読み取りの後まで、ずっと進行中の要求が 0 だったときだけ（間に要求が
//   始まったら、静かな時間を数え直し、読み取りも組み直す）。読み取りが失敗したら、落ち着いていないとみなす。
// - 待ちの間に、読み込みを足さない（`page.reload`・`goto` をしない）。ページに何もしない。読み取りの関数（呼ぶ側が渡す。ページを読むだけ）を
//   呼び、時間を待つだけ。
// - 進行中の要求の数え方（`InFlightRequestCounter`）: Playwright の page の `request` の事象で数え始め、同じ要求の `requestfinished` か
//   `requestfailed` で終わりとする（Guard が止めた要求も `requestfailed` で終わる）。数え始める前に始まった要求は数えられないので、呼ぶ側は、
//   画面を読み込む前（`goto` の前）に作る。終わりの事象の来ない要求（長く開いたままの要求など）があると、上限まで待って `TIMED_OUT` になる
//   （fail-closed の向き）。Guard の中の進行中の数（`pendingRequestTaskCount`）は外から読めず、Guard は変えない（T27b の範囲の外）ので使わない。
// - DEF-127（T37a fix round 1）: ページが応答の本文を読まない要求（`fetch` の結果の `ok` だけを見るなど）は、Chromium が本文を受け取りきらず、
//   `requestfinished` が上限まで来ないことがある（実機で確かめた）。T37R-fix-B（T37R の I-2）: 応答を受けた要求は、応答から名前つきの猶予
//   （`DISCOVERY_RESPONSE_BODY_GRACE_MS`。既定 2 秒）までは進行中に数え（本文が遅い応答で、描かれる前に読まない）、猶予を過ぎたら外す（本文を読まない
//   応答でも、上限まで待たない）。猶予を超えて本文が遅い応答は、描かれる前に読みうる（限界）。待ちの条件の「2 回続けて同じ候補の集合」は今どおり。この
//   数え方は落ち着きの待ちだけのもので、Guard の安全の数え方（止めた要求、上限の部品）と、負荷の数え方（`load-meter.ts`。DEF-121）には関わらない。
import type { Page, Request, Response } from 'playwright';
import { awaitBeforeDeadline, wait } from '../core/deadline.js';

/** 進行中の要求が 0 の状態が続く時間（ms。設計書 4.2）。 */
export const DISCOVERY_NETWORK_QUIET_MS = 500;
/** 落ち着きの待ちの上限（ms。設計書 4.2）。超えたら `INCOMPLETE_SETTLE_TIMEOUT`。 */
export const DISCOVERY_SETTLE_TIMEOUT_MS = 5_000;
/** 静かになるのを確かめる間隔（ms）。 */
export const DISCOVERY_SETTLE_POLL_INTERVAL_MS = 50;
/** 2 回の読み取りの、始まりの間の最小の間隔（ms。描画の後の短い遅れを、同じ集合と取り違えないため）。 */
export const DISCOVERY_SETTLE_PROBE_INTERVAL_MS = 250;
/**
 * 応答を受けた後、本文の終わり（`requestfinished`・`requestfailed`）を待つ猶予（ms。T37R-fix-B。Task 37 の設計書 8 章の T37R の行の I-2。設計者の判断の
 * 既定 2 秒）。猶予の間は進行中に数え、過ぎたら外す。
 */
export const DISCOVERY_RESPONSE_BODY_GRACE_MS = 2_000;

/** 落ち着きの待ちの指定。 */
export interface DiscoverySettlePolicy {
  readonly timeoutMs: number;
  readonly networkQuietMs: number;
  readonly pollIntervalMs: number;
  readonly probeIntervalMs: number;
}

/** 本番の指定（設計書 4.2 の名前つきの定数）。 */
export const DISCOVERY_SETTLE_POLICY: DiscoverySettlePolicy = Object.freeze({
  timeoutMs: DISCOVERY_SETTLE_TIMEOUT_MS,
  networkQuietMs: DISCOVERY_NETWORK_QUIET_MS,
  pollIntervalMs: DISCOVERY_SETTLE_POLL_INTERVAL_MS,
  probeIntervalMs: DISCOVERY_SETTLE_PROBE_INTERVAL_MS,
});

/** 進行中の要求が 0 になった時刻（`Date.now()`）を返す源。進行中の要求があれば `null`。 */
export interface QuietSource {
  quietSinceMs(): number | null;
}

/** page の要求の事象の名前（数え始めと、終わり。Guard が止めた要求も `requestfailed` で終わる）。 */
const REQUEST_START_EVENT = 'request';
/** DEF-127: 応答を受けた（ヘッダを受けた）事象。応答を受けた要求は、進行中から外す。 */
const RESPONSE_EVENT = 'response';
const REQUEST_FINISHED_EVENT = 'requestfinished';
const REQUEST_FAILED_EVENT = 'requestfailed';

/**
 * page の進行中の要求を数える（ページに何もしない。事象を受けるだけ）。画面を読み込む前に作り、使い終わったら `dispose` で事象の受け口を外す。
 */
export class InFlightRequestCounter implements QuietSource {
  readonly #page: Page;
  /** 進行中の要求と、応答を受けた時刻（`Date.now()`。まだなら `null`）。 */
  readonly #inFlight = new Map<Request, number | null>();
  /** 応答の後の猶予（ms。T37R-fix-B）。 */
  readonly #responseBodyGraceMs: number;
  /** 最後に進行中の要求が終わった（か猶予を過ぎた）時刻。作った時点から数える。 */
  #lastEndMs: number = Date.now();
  #disposed = false;

  readonly #onStart = (request: Request): void => {
    this.#inFlight.set(request, null);
  };

  readonly #onEnd = (request: Request): void => {
    if (this.#inFlight.delete(request)) {
      this.#lastEndMs = Math.max(this.#lastEndMs, Date.now());
    }
  };

  /**
   * DEF-127・T37R-fix-B（T37R の I-2）: 応答を受けた要求は、応答から猶予（`responseBodyGraceMs`）を過ぎたら進行中から外す（猶予の間は、本文が届いて画面が
   * 描かれるのを待つ。本文を読まない応答で `requestfinished` が来なくても、猶予で終わる）。読めない応答は無視する（今どおり終わりの事象を待つ）。
   */
  readonly #onResponse = (response: Response): void => {
    try {
      const request = response.request();
      if (this.#inFlight.get(request) === null) {
        this.#inFlight.set(request, Date.now());
      }
    } catch {
      // 読めない応答は、今どおり終わりの事象を待つ。
    }
  };

  constructor(page: Page, options: { readonly responseBodyGraceMs?: number } = {}) {
    this.#page = page;
    this.#responseBodyGraceMs = options.responseBodyGraceMs ?? DISCOVERY_RESPONSE_BODY_GRACE_MS;
    page.on(REQUEST_START_EVENT, this.#onStart);
    page.on(RESPONSE_EVENT, this.#onResponse);
    page.on(REQUEST_FINISHED_EVENT, this.#onEnd);
    page.on(REQUEST_FAILED_EVENT, this.#onEnd);
  }

  /** 猶予を過ぎた要求を、猶予の終わりの時刻で終わったものとして外す。 */
  #pruneExpired(nowMs: number): void {
    for (const [request, respondedAtMs] of this.#inFlight) {
      if (respondedAtMs !== null && nowMs - respondedAtMs >= this.#responseBodyGraceMs) {
        this.#inFlight.delete(request);
        this.#lastEndMs = Math.max(this.#lastEndMs, respondedAtMs + this.#responseBodyGraceMs);
      }
    }
  }

  /** 進行中の要求の数（応答の後の猶予の間の要求を含む）。 */
  get inFlight(): number {
    this.#pruneExpired(Date.now());
    return this.#inFlight.size;
  }

  quietSinceMs(): number | null {
    this.#pruneExpired(Date.now());
    return this.#inFlight.size === 0 ? this.#lastEndMs : null;
  }

  /** 事象の受け口を外す（何度呼んでもよい）。外した後は数えない。 */
  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#page.off(REQUEST_START_EVENT, this.#onStart);
    this.#page.off(RESPONSE_EVENT, this.#onResponse);
    this.#page.off(REQUEST_FINISHED_EVENT, this.#onEnd);
    this.#page.off(REQUEST_FAILED_EVENT, this.#onEnd);
  }
}

/** 落ち着きの待ちの結果。 */
export type DiscoverySettleOutcome = { readonly status: 'SETTLED' } | { readonly status: 'TIMED_OUT' };

const SETTLED: DiscoverySettleOutcome = Object.freeze({ status: 'SETTLED' });
const TIMED_OUT: DiscoverySettleOutcome = Object.freeze({ status: 'TIMED_OUT' });

/**
 * 候補の集合を読む関数（呼ぶ側が渡す。ページを読むだけ）。識別の digest の一覧（順は問わない）か、読めなければ `null`。`deadlineAtMs` までに
 * 終える。
 */
export type CandidateSetReader = (deadlineAtMs: number) => Promise<readonly string[] | null>;

/** 集合として同じか（重複を除き、順を問わない）。 */
const sameSet = (left: readonly string[], right: readonly string[]): boolean => {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
};

/** 組の 1 回目にできる読み取り（集合と、読み始めた時刻）。 */
interface PairableRead {
  readonly set: readonly string[];
  readonly startedAtMs: number;
}

/**
 * 落ち着くまで待つ（例外を投げない）。`policy` は試験のために差し替えられる（本番は `DISCOVERY_SETTLE_POLICY`）。
 */
export async function waitForDiscoverySettled(
  source: QuietSource,
  readCandidateSet: CandidateSetReader,
  policy: DiscoverySettlePolicy = DISCOVERY_SETTLE_POLICY,
): Promise<DiscoverySettleOutcome> {
  const deadlineAtMs = Date.now() + policy.timeoutMs;
  let previous: PairableRead | null = null;
  /** 最後に読み始めた時刻（失敗した読み取りを含む。読み取りの間隔を空けるため）。 */
  let lastReadStartedAtMs: number | null = null;
  while (Date.now() < deadlineAtMs) {
    const quietSince = source.quietSinceMs();
    const now = Date.now();
    const quietLongEnough = quietSince !== null && now - quietSince >= policy.networkQuietMs;
    const spacedEnough = lastReadStartedAtMs === null || now - lastReadStartedAtMs >= policy.probeIntervalMs;
    if (quietSince === null || !quietLongEnough || !spacedEnough) {
      await wait(Math.max(0, Math.min(policy.pollIntervalMs, deadlineAtMs - now)));
      continue;
    }
    const startedAtMs = Date.now();
    lastReadStartedAtMs = startedAtMs;
    const outcome = await awaitBeforeDeadline(readCandidateSet(deadlineAtMs), deadlineAtMs);
    const set = outcome.status === 'FULFILLED' ? outcome.value : null;
    // 読み取りの間も静かだったか（読み取りの前と後で、静かになった時刻が変わらない）。
    const quietThroughout = source.quietSinceMs() === quietSince;
    if (set === null || !quietThroughout) {
      previous = null;
      continue;
    }
    if (previous !== null && quietSince <= previous.startedAtMs && sameSet(previous.set, set) && Date.now() < deadlineAtMs) {
      return SETTLED;
    }
    previous = { set, startedAtMs };
  }
  return TIMED_OUT;
}
