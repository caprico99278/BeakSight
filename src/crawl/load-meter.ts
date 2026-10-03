import { isBlockedByClientFailure } from '../browser/playwright-errors.js';
import type { RunLoadOriginRequests, RunLoadRecentPerMinute, RunLoadRequests } from '../core/contracts.js';
import { isNonNegativeSafeInteger, isRecord } from '../core/guards.js';
import { canonicalPassiveAllowedOrigins, hasAllowedOrigin } from '../safety/request-policy.js';

/**
 * 1分あたりの最大（`peakPerMinute`）を数える時間の幅（ms）。直近のこの時間に終わった要求の件数の最大を記録する。
 * 実行中の進み具合の、直近の1分の件数（`recentPerMinute`）も、同じ幅で数える。
 */
export const LOAD_PEAK_WINDOW_MS = 60_000;

/**
 * BeakSight が監査対象のサイトに送った要求の実績を数える部品（サイトへの負荷の制御の設計書 3.1 の7、4.5。この意味の owner）。
 * Run Coordinator が Run の初めに1つだけ作り、PREFLIGHT の `contextFactoryOptions` を通して `BrowserContextFactory` に渡す
 * （factory を作るのは PREFLIGHT）。factory は、作るすべての Context の
 * 要求の終わりの事象（`requestfinished` と `requestfailed`）を、ここに渡すだけで、自分では数えない。
 *
 * 数えないもの（ネットワークに送らなかった要求）:
 * - 失敗の理由が、`route.abort('blockedbyclient')` で止めた要求の理由（`isBlockedByClientFailure`、`src/browser/playwright-errors.ts`。
 *   完全一致の閉じた一覧）の要求。Guard、またはリソースの届け方の部品が止めた要求である。一覧にない理由の失敗は数える。
 * - Run 全体のキャッシュから返した印（`recordServedFromRunCache`）の付いた要求。
 *
 * ブラウザ自身のキャッシュから返った要求でも、事象が来れば数える（多めに数える側）。
 */
export interface LoadMeter {
  /** 要求が終わった（`requestfinished`）。`request` は要求を見分ける鍵（Playwright の `Request`）で、印の照合だけに使う。 */
  recordRequestFinished(request: object, url: string): void;
  /** 要求が失敗した（`requestfailed`）。`errorText` は失敗の理由（`request.failure()?.errorText`。なければ `null`）。 */
  recordRequestFailed(request: object, url: string, errorText: string | null): void;
  /**
   * `request` を、Run 全体のキャッシュから返した要求として印を付け、`servedFromCache` を1増やす（リソースの届け方の部品が、
   * 返す前に呼ぶ）。印の付いた要求は、その後の終わりの事象で数えない。同じ要求に2回付けても、1回と数える。
   */
  recordServedFromRunCache(request: object): void;
  /** 許可 Origin の外への要求を送らなかったことを記録し、`withheldOtherOrigins` を1増やす（リソースの届け方の部品が呼ぶ）。 */
  recordWithheld(): void;
  /** これまでの記録（run.json の `load.requests` と同じ形。JSON にできる、凍結した値）。 */
  snapshot(): RunLoadRequests;
  /**
   * 区分ごとの、直近の1分に終わった要求の件数（実行中の進み具合の表示に使う。サイトへの負荷の制御の設計書 4.8。JSON にできる、凍結した値）。
   * 今の時刻（`now()`）から `LOAD_PEAK_WINDOW_MS` 以上前に終わった要求を除いて数える。1分あたりの最大と同じ窓で、同じ要求を数える。
   */
  recentPerMinute(): RunLoadRecentPerMinute;
}

/** `createLoadMeter` の入力。 */
export interface LoadMeterOptions {
  /** 許可 Origin（設定の `site.allowedOrigins`）。判定は Guard と同じ `hasAllowedOrigin` で行う。 */
  readonly allowedOrigins: readonly string[];
  /** 現在の時刻（エポックからの ms。0 以上の安全な整数）。Run Coordinator に注入された `now`。 */
  readonly now: () => number;
  /**
   * 再開のときに、前の回の記録（`snapshot()` の値）を引き継ぐ（再開の設計書）。省略すると 0 から始める。
   * 1分あたりの最大は、この値と、作り直した後の最大の、大きい方にする。直近の1分の時刻は引き継がない。
   */
  readonly initial?: RunLoadRequests;
}

/** 1つの区分の、数えている途中の状態。`windowEndTimesMs` は、直近の1分に終わった要求の時刻（古い順）。 */
interface OriginTally {
  count: number;
  peakPerMinute: number;
  readonly windowEndTimesMs: number[];
}

/**
 * `LoadMeter` を作る（サイトへの負荷の制御の設計書 4.5）。
 *
 * - 要求の URL が許可 Origin に含まれるかを `hasAllowedOrigin`（`src/safety/request-policy.ts`）で判定し、`allowedOrigins` と
 *   `otherOrigins` に分けて数える。URL として解釈できないもの（`data:` など、Origin を持たないものを含む）は、`otherOrigins` に数える。
 * - 1分あたりの最大は、区分ごとに、数えた要求の時刻（`now()`）を直近の `LOAD_PEAK_WINDOW_MS` の分だけ持ち、その件数の最大とする。
 *   それより古い時刻は捨てる（持つ量は、直近の1分の件数に限られる）。時計が戻った場合は、戻る前の最後の時刻に終わったものとして扱う
 *   （持つ時刻を古い順に保つため）。
 * - 直近の1分の件数（`recentPerMinute`。設計書 4.8）は、区分ごとに、持っている時刻のうち、今の時刻（`now()`。時計が戻った場合は、
 *   最後に数えた時刻）から `LOAD_PEAK_WINDOW_MS` 以上前のものを除いて数える。窓の決め方は、1分あたりの最大と同じ（`isWithinPeakWindow`）。
 *   持つ時刻は変えない（捨てるのは、次に数えるとき）。今の時刻で捨てた後に時計が戻ると、戻った後の最大を少なく数えるためである。
 *
 * 不正な入力: 入力がオブジェクトでない、`allowedOrigins` が文字列の配列でない、`now` が関数でない、`initial`（とその区分）が
 * オブジェクトでないなら `TypeError`、`initial` の値が 0 以上の安全な整数でないなら `RangeError` を投げる。
 * `now()` が 0 以上の安全な整数を返さない場合は、数える呼び出しが `RangeError` を投げる（記録は変えない）。
 */
export function createLoadMeter(options: LoadMeterOptions): LoadMeter {
  if (!isRecord(options)) {
    throw new TypeError('LoadMeter options must be an object');
  }
  const { allowedOrigins, now, initial } = options;
  if (!Array.isArray(allowedOrigins) || !allowedOrigins.every((origin) => typeof origin === 'string')) {
    throw new TypeError('LoadMeter allowed origins must be an array of strings');
  }
  if (typeof now !== 'function') {
    throw new TypeError('LoadMeter requires a current time function');
  }
  const start = validatedInitial(initial);
  const canonicalAllowedOrigins = canonicalPassiveAllowedOrigins(new Set(allowedOrigins));
  const allowed = tallyFrom(start.allowedOrigins);
  const other = tallyFrom(start.otherOrigins);
  let servedFromCache = start.servedFromCache;
  let withheldOtherOrigins = start.withheldOtherOrigins;
  const servedFromRunCache = new WeakSet<object>();
  let lastEndTimeMs: number | null = null;

  const currentTimeMs = (): number => {
    const value = now();
    if (!isNonNegativeSafeInteger(value)) {
      throw new RangeError('LoadMeter current time must be a non-negative safe integer of milliseconds');
    }
    return lastEndTimeMs === null ? value : Math.max(value, lastEndTimeMs);
  };

  const count = (request: object, url: string): void => {
    if (servedFromRunCache.has(request)) {
      return;
    }
    const endTimeMs = currentTimeMs();
    lastEndTimeMs = endTimeMs;
    const tally = hasAllowedOrigin(url, canonicalAllowedOrigins) ? allowed : other;
    tally.count += 1;
    const window = tally.windowEndTimesMs;
    while (window.length > 0 && !isWithinPeakWindow(window[0] ?? endTimeMs, endTimeMs)) {
      window.shift();
    }
    window.push(endTimeMs);
    tally.peakPerMinute = Math.max(tally.peakPerMinute, window.length);
  };

  return Object.freeze({
    recordRequestFinished(request: object, url: string): void {
      count(request, url);
    },
    recordRequestFailed(request: object, url: string, errorText: string | null): void {
      if (isBlockedByClientFailure(errorText)) {
        return;
      }
      count(request, url);
    },
    recordServedFromRunCache(request: object): void {
      if (servedFromRunCache.has(request)) {
        return;
      }
      servedFromRunCache.add(request);
      servedFromCache += 1;
    },
    recordWithheld(): void {
      withheldOtherOrigins += 1;
    },
    snapshot(): RunLoadRequests {
      return Object.freeze({
        allowedOrigins: originSnapshot(allowed),
        otherOrigins: originSnapshot(other),
        servedFromCache,
        withheldOtherOrigins,
      });
    },
    recentPerMinute(): RunLoadRecentPerMinute {
      const nowMs = currentTimeMs();
      return Object.freeze({
        allowedOrigins: recentCount(allowed, nowMs),
        otherOrigins: recentCount(other, nowMs),
      });
    },
  });
}

/** `endTimeMs` に終わった要求が、`nowMs` の時点の直近の1分（`LOAD_PEAK_WINDOW_MS`）に入るか。1分あたりの最大と直近の1分の件数の、窓の決め方。 */
function isWithinPeakWindow(endTimeMs: number, nowMs: number): boolean {
  return nowMs - endTimeMs < LOAD_PEAK_WINDOW_MS;
}

/** 区分の、`nowMs` の時点の直近の1分に終わった要求の件数。持つ時刻は変えない。 */
function recentCount(tally: OriginTally, nowMs: number): number {
  return tally.windowEndTimesMs.filter((endTimeMs) => isWithinPeakWindow(endTimeMs, nowMs)).length;
}

function tallyFrom(initial: RunLoadOriginRequests): OriginTally {
  return { count: initial.count, peakPerMinute: initial.peakPerMinute, windowEndTimesMs: [] };
}

function originSnapshot(tally: OriginTally): RunLoadOriginRequests {
  return Object.freeze({ count: tally.count, peakPerMinute: tally.peakPerMinute });
}

const EMPTY_ORIGIN_REQUESTS: RunLoadOriginRequests = Object.freeze({ count: 0, peakPerMinute: 0 });

/** 引き継ぐ記録を確かめ、写しを返す。省略した場合は、0 から始める記録を返す。 */
function validatedInitial(initial: RunLoadRequests | undefined): RunLoadRequests {
  if (initial === undefined) {
    return { allowedOrigins: EMPTY_ORIGIN_REQUESTS, otherOrigins: EMPTY_ORIGIN_REQUESTS, servedFromCache: 0, withheldOtherOrigins: 0 };
  }
  if (!isRecord(initial)) {
    throw new TypeError('LoadMeter initial record must be an object');
  }
  const { servedFromCache, withheldOtherOrigins } = initial;
  if (!isNonNegativeSafeInteger(servedFromCache) || !isNonNegativeSafeInteger(withheldOtherOrigins)) {
    throw new RangeError('LoadMeter initial record values must be non-negative safe integers');
  }
  return {
    allowedOrigins: validatedOriginRequests(initial.allowedOrigins),
    otherOrigins: validatedOriginRequests(initial.otherOrigins),
    servedFromCache,
    withheldOtherOrigins,
  };
}

function validatedOriginRequests(value: unknown): RunLoadOriginRequests {
  if (!isRecord(value)) {
    throw new TypeError('LoadMeter initial origin requests must be an object');
  }
  const { count, peakPerMinute } = value;
  if (!isNonNegativeSafeInteger(count) || !isNonNegativeSafeInteger(peakPerMinute)) {
    throw new RangeError('LoadMeter initial record values must be non-negative safe integers');
  }
  return { count, peakPerMinute };
}
