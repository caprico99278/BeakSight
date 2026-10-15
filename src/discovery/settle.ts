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
import type { Page, Request } from 'playwright';
import { awaitBeforeDeadline, wait } from '../core/deadline.js';

/** 進行中の要求が 0 の状態が続く時間（ms。設計書 4.2）。 */
export const DISCOVERY_NETWORK_QUIET_MS = 500;
/** 落ち着きの待ちの上限（ms。設計書 4.2）。超えたら `INCOMPLETE_SETTLE_TIMEOUT`。 */
export const DISCOVERY_SETTLE_TIMEOUT_MS = 5_000;
/** 静かになるのを確かめる間隔（ms）。 */
export const DISCOVERY_SETTLE_POLL_INTERVAL_MS = 50;
/** 2 回の読み取りの、始まりの間の最小の間隔（ms。描画の後の短い遅れを、同じ集合と取り違えないため）。 */
export const DISCOVERY_SETTLE_PROBE_INTERVAL_MS = 250;

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
const REQUEST_FINISHED_EVENT = 'requestfinished';
const REQUEST_FAILED_EVENT = 'requestfailed';

/**
 * page の進行中の要求を数える（ページに何もしない。事象を受けるだけ）。画面を読み込む前に作り、使い終わったら `dispose` で事象の受け口を外す。
 */
export class InFlightRequestCounter implements QuietSource {
  readonly #page: Page;
  readonly #inFlight = new Set<Request>();
  #quietSinceMs: number | null = Date.now();
  #disposed = false;

  readonly #onStart = (request: Request): void => {
    this.#inFlight.add(request);
    this.#quietSinceMs = null;
  };

  readonly #onEnd = (request: Request): void => {
    if (this.#inFlight.delete(request) && this.#inFlight.size === 0) {
      this.#quietSinceMs = Date.now();
    }
  };

  constructor(page: Page) {
    this.#page = page;
    page.on(REQUEST_START_EVENT, this.#onStart);
    page.on(REQUEST_FINISHED_EVENT, this.#onEnd);
    page.on(REQUEST_FAILED_EVENT, this.#onEnd);
  }

  /** 進行中の要求の数。 */
  get inFlight(): number {
    return this.#inFlight.size;
  }

  quietSinceMs(): number | null {
    return this.#quietSinceMs;
  }

  /** 事象の受け口を外す（何度呼んでもよい）。外した後は数えない。 */
  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#page.off(REQUEST_START_EVENT, this.#onStart);
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
