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
// - DEF-265（T37R の I-2 の形に戻した）: 応答（ヘッダ）を受けた要求は、終わりの事象（`requestfinished`・`requestfailed`）か、応答から
//   `DISCOVERY_RESPONSE_BODY_GRACE_MS` の早いほうまで、進行中に数える（本文の遅い応答で、描かれる前に読まない）。DEF-127: ページが応答の本文を読まない
//   要求（`fetch(...).catch(...)` など）には、Chromium が終わりの事象を出さない（Guard がなくても同じ）が、猶予の後に外れるので、上限まで待たない。
//   この数え方は落ち着きの待ちだけのもので、監査の側の数え方（`network-collector.ts` の `createDataRequestTracker`）、Guard の安全の数え方（止めた
//   要求、上限の部品）と、負荷の数え方（`load-meter.ts`。DEF-121）には関わらない。
import type { Page, Request, Response } from 'playwright';
import { SYSTEM_CLOCK, type Clock } from '../core/clock.js';
import { awaitBeforeDeadline } from '../core/deadline.js';
import { PRODUCTION_OBSERVATION_WINDOWS, type ObservationWindows } from '../core/observation-windows.js';
import { watchProgress, type ProgressSignals } from '../core/progress-watch.js';
import { OPEN_ENDED_STAGE_MS } from '../orchestration/stage-deadline.js';
import { requestEndpointKeyOf } from '../core/request-endpoint-key.js';
import { dataQuietnessOf, progressStoppedOf, type DataActivity } from '../browser/page-settling.js';

// RB-2: 次の待ちの値は、観察の窓の一式（`discoverySettle`）の本番の値から導く。
const SETTLE_WINDOWS = PRODUCTION_OBSERVATION_WINDOWS.discoverySettle;
/** 進行中の要求が 0 の状態が続く時間（ms。設計書 4.2）。 */
export const DISCOVERY_NETWORK_QUIET_MS = SETTLE_WINDOWS.networkQuietMs;
/** 落ち着きの待ちの上限（ms。設計書 4.2）。超えたら `INCOMPLETE_SETTLE_TIMEOUT`。 */
export const DISCOVERY_SETTLE_TIMEOUT_MS = SETTLE_WINDOWS.timeoutMs;
/** 静かになるのを確かめる間隔（ms）。 */
export const DISCOVERY_SETTLE_POLL_INTERVAL_MS = SETTLE_WINDOWS.pollIntervalMs;
/** 2 回の読み取りの、始まりの間の最小の間隔（ms。描画の後の短い遅れを、同じ集合と取り違えないため）。 */
export const DISCOVERY_SETTLE_PROBE_INTERVAL_MS = SETTLE_WINDOWS.probeIntervalMs;
/**
 * 応答を受けた後に、本文の終わり（終わりの事象）を待つ猶予（ms）。DEF-265: LZ-1 で一度撤廃したが、本文の遅い応答（1.5 秒）の READ が描かれる前に読んで
 * NOT_MATCHED に戻った（T37R の I-2）ので戻した。本文を読まない要求（DEF-127）は、この猶予の後に進行中から外れる（上限まで待たない）。
 */
export const DISCOVERY_RESPONSE_BODY_GRACE_MS = SETTLE_WINDOWS.responseBodyGraceMs;

/** 落ち着きの待ちの指定。 */
export interface DiscoverySettlePolicy {
  readonly timeoutMs: number;
  readonly networkQuietMs: number;
  readonly pollIntervalMs: number;
  readonly probeIntervalMs: number;
  /**
   * DEF-290: まだ届いていない口の要求が残っていても、途中の要求の組が変わらない状態がこの長さ続いたら、読みに行く（ms。DEF-283 の C と同じ判定
   * `progressStoppedOf`。省略は、その判定が持つ本番の開いた要求の静まり）。
   */
  readonly openDataRequestQuietMs?: number | undefined;
}

/** 本番の指定（設計書 4.2 の名前つきの定数）。 */
export const DISCOVERY_SETTLE_POLICY: DiscoverySettlePolicy = Object.freeze({
  timeoutMs: DISCOVERY_SETTLE_TIMEOUT_MS,
  networkQuietMs: DISCOVERY_NETWORK_QUIET_MS,
  pollIntervalMs: DISCOVERY_SETTLE_POLL_INTERVAL_MS,
  probeIntervalMs: DISCOVERY_SETTLE_PROBE_INTERVAL_MS,
});

/**
 * RB-fix-456（RB-11 の書き込みの流れの分）: 差し込まれた観察の窓の一式（テストだけ）の `discoverySettle` から作る落ち着きの待ちの指定。差し込まれていなければ
 * `undefined`（受ける部品が本番の `DISCOVERY_SETTLE_POLICY` を使う）。本番の入口は一式を渡さないので、本番の値のまま。
 */
export const discoverySettlePolicyOf = (injected: ObservationWindows | undefined): DiscoverySettlePolicy | undefined =>
  (injected === undefined ? undefined : settlePolicyOfWindows(injected));

/**
 * RB-11: 観察の窓の一式の `discoverySettle` から作る落ち着きの待ちの指定（書き込みと READ の部品が、受けた一式か本番の一式から作る）。`busy` は、同じ Run で
 * 要求が止む待ちの上限に届いた画面の指定（上限だけを `busyTimeoutMs` に縮める）。
 */
export const settlePolicyOfWindows = (windows: ObservationWindows, busy = false): DiscoverySettlePolicy => {
  const { timeoutMs, networkQuietMs, pollIntervalMs, probeIntervalMs, busyTimeoutMs } = windows.discoverySettle;
  return Object.freeze({
    timeoutMs: busy ? busyTimeoutMs : timeoutMs, networkQuietMs, pollIntervalMs, probeIntervalMs, openDataRequestQuietMs: windows.pageSettle.openDataRequestQuietMs,
  });
};

/** 進行中の要求が 0 になった時刻（`Date.now()`）を返す源。進行中の要求があれば `null`。 */
export interface QuietSource {
  quietSinceMs(): number | null;
  /** DEF-290: 今の要求の数と口ごとの事実（あれば、答えない長い要求で待ち続けないために使う。省略は今のまま）。 */
  dataActivity?(): DataActivity;
  /** REV-DQF fix round 3: 前の画面までに出た送り先（この画面で新しい送り先でない。省略はなし）。 */
  knownEndpoints?(): ReadonlySet<string>;
}

/** REV-DQF fix round 3: Run の中で、前の画面までに出たデータの送り先の覚え（口の印 `requestEndpointKeyOf`。メモリの中だけで、記録しない）。 */
export interface DataEndpointMemory {
  readonly known: () => ReadonlySet<string>;
  readonly remember: (endpoints: Iterable<string>) => void;
}

/** REV-DQF fix round 3: 空の覚えを作る（発見の流れが Run ごとに 1 つ作る）。 */
export const createDataEndpointMemory = (): DataEndpointMemory => {
  const endpoints = new Set<string>();
  return Object.freeze({
    known: (): ReadonlySet<string> => endpoints,
    remember: (seen: Iterable<string>): void => {
      for (const endpoint of seen) endpoints.add(endpoint);
    },
  });
};

/** page の要求の事象の名前（数え始めと、終わり。Guard が止めた要求も `requestfailed` で終わる）。 */
const REQUEST_START_EVENT = 'request';
/** DEF-265: 応答を受けた（ヘッダを受けた）事象。応答を受けた要求は、猶予（`DISCOVERY_RESPONSE_BODY_GRACE_MS`）の後に進行中から外す。 */
const RESPONSE_EVENT = 'response';
const REQUEST_FINISHED_EVENT = 'requestfinished';
const REQUEST_FAILED_EVENT = 'requestfailed';

/**
 * page の進行中の要求を数える（ページに何もしない。事象を受けるだけ）。画面を読み込む前に作り、使い終わったら `dispose` で事象の受け口を外す。
 */
export class InFlightRequestCounter implements QuietSource {
  readonly #page: Page;
  /**
   * 進行中の要求（終わりの事象が来ず、応答の後の猶予も過ぎていない）と、その口（`requestEndpointKeyOf`。読めない要求は、その要求だけの印）と、応答を受けた
   * 時刻（まだなら `null`）。
   */
  readonly #inFlight = new Map<Request, { readonly endpoint: string; respondedAtMs: number | null }>();
  /**
   * L6/L3-1 の続き（設計者の判断 2026-11-10。口ごとの静まり）: 一度応答を返し終えた口（`requestfinished`、または応答の後の猶予が過ぎた）。この口への
   * くり返しの要求（ポーリング）は、静まりを止めない（`quietSinceMs`・`dataActivity` の `endpoints`。判定は `dataQuietnessOf` と同じ形）。
   */
  readonly #completedEndpoints = new Set<string>();
  /**
   * COV-4 の決まり（`dataQuietnessOf` の `failed`）に揃える: 失敗で終わった口（`requestfailed`。Guard が止めた要求を含む）。この口へのくり返しも、静まりを止めない
   * （失敗し続ける口へのくり返しで、静まらなくならない）。
   */
  readonly #failedEndpoints = new Set<string>();
  /** 最後に、まだ応答を返し終えていない口への要求が終わった（終わりの事象・猶予の終わり・失敗）時刻。作った時点から数える。 */
  #lastEndMs: number;
  /** RB-8: 時刻を読む時計と、応答の後の本文の猶予（ms。テストだけが差し込む。本番は本物の時計と `DISCOVERY_RESPONSE_BODY_GRACE_MS`）。 */
  readonly #clock: Clock;
  readonly #responseBodyGraceMs: number;
  #disposed = false;
  /** 口を読めない要求に付ける、その要求だけの印の番号。 */
  #unknownEndpoints = 0;

  /** COV-3: 要求の始まりと終わりの通しの数（`dataActivity`。通信が動いたかを見る）。 */
  #events = 0;
  /** REV-DQF fix round 3: この画面で出た送り先（次の画面に、新しい送り先でないと伝える）と、前の画面までに出た送り先を読む口。 */
  readonly #seenEndpoints = new Set<string>();
  readonly #knownEndpoints: (() => ReadonlySet<string>) | undefined;

  /** QUIET-3: 口ごとの、要求が始まった数（`dataActivity` の `endpoints.started`）。 */
  readonly #startedEndpoints = new Map<string, number>();

  readonly #onStart = (request: Request): void => {
    const unknownBefore = this.#unknownEndpoints;
    const endpoint = this.#endpointOf(request);
    this.#startedEndpoints.set(endpoint, (this.#startedEndpoints.get(endpoint) ?? 0) + 1);
    // 口を読めない要求の印は、この画面の中だけの番号なので、覚えない。
    if (this.#unknownEndpoints === unknownBefore) this.#seenEndpoints.add(endpoint);
    this.#inFlight.set(request, { endpoint, respondedAtMs: null });
    this.#events += 1;
  };

  /** 要求の口（読めない要求は、その要求だけの印。ほかの要求と同じ口にしない）。 */
  #endpointOf(request: Request): string {
    try {
      return requestEndpointKeyOf(request.method(), request.url());
    } catch {
      this.#unknownEndpoints += 1;
      return `unknown-endpoint-${String(this.#unknownEndpoints)}`;
    }
  }

  /** まだ応答を返し終えていない口への要求か（静まりを止める要求）。 */
  #pending(endpoint: string): boolean {
    return !this.#completedEndpoints.has(endpoint) && !this.#failedEndpoints.has(endpoint);
  }

  /** 要求の終わり。`answered` は応答を返し終えた（`requestfinished`・猶予の終わり）。失敗（`requestfailed`。Guard が止めた要求を含む）は返し終えていない。 */
  #end(request: Request, endedAtMs: number, answered: boolean): void {
    const entry = this.#inFlight.get(request);
    if (entry === undefined) {
      return;
    }
    this.#inFlight.delete(request);
    if (this.#pending(entry.endpoint)) {
      this.#lastEndMs = Math.max(this.#lastEndMs, endedAtMs);
    }
    if (answered) {
      this.#completedEndpoints.add(entry.endpoint);
    } else {
      this.#failedEndpoints.add(entry.endpoint);
    }
  }

  readonly #onFinished = (request: Request): void => {
    this.#end(request, this.#clock.now(), true);
    this.#events += 1;
  };

  readonly #onFailed = (request: Request): void => {
    this.#end(request, this.#clock.now(), false);
    this.#events += 1;
  };

  /**
   * DEF-265: 応答（ヘッダ）を受けた時刻を覚える（要求は、終わりの事象か猶予の終わりまで進行中のまま）。読めない応答は無視する（終わりの事象を待つ）。
   */
  readonly #onResponse = (response: Response): void => {
    try {
      const entry = this.#inFlight.get(response.request());
      if (entry !== undefined && entry.respondedAtMs === null) {
        entry.respondedAtMs = this.#clock.now();
      }
    } catch {
      // 読めない応答は、今どおり終わりの事象を待つ。
    }
  };

  /**
   * DEF-265・DEF-127: 応答から猶予（`DISCOVERY_RESPONSE_BODY_GRACE_MS`）が過ぎた要求を、猶予の終わりの時刻に返し終えたものとして外す（本文を読まない要求で、
   * 上限まで待たない）。後から来る終わりの事象は、もう数えない。
   */
  #expireGrace(): void {
    const now = this.#clock.now();
    const graceMs = this.#responseBodyGraceMs;
    const expired = [...this.#inFlight].flatMap(([request, { respondedAtMs }]) =>
      (respondedAtMs !== null && now - respondedAtMs >= graceMs ? [[request, respondedAtMs + graceMs] as const] : []));
    for (const [request, endedAtMs] of expired) {
      this.#end(request, endedAtMs, true);
      this.#events += 1;
    }
  }

  constructor(
    page: Page,
    /** RB-8: テストだけが差し込む時計と本文の猶予（観察の窓の一式の `discoverySettle.responseBodyGraceMs`）。省略は本番。 */
    options: {
      readonly clock?: Clock | undefined;
      readonly responseBodyGraceMs?: number | undefined;
      /** REV-DQF fix round 3: 前の画面までに出た送り先を読む口（省略はなし）。 */
      readonly knownEndpoints?: (() => ReadonlySet<string>) | undefined;
    } = {},
  ) {
    this.#page = page;
    this.#knownEndpoints = options.knownEndpoints;
    this.#clock = options.clock ?? SYSTEM_CLOCK;
    this.#responseBodyGraceMs = options.responseBodyGraceMs ?? DISCOVERY_RESPONSE_BODY_GRACE_MS;
    this.#lastEndMs = this.#clock.now();
    page.on(REQUEST_START_EVENT, this.#onStart);
    page.on(RESPONSE_EVENT, this.#onResponse);
    page.on(REQUEST_FINISHED_EVENT, this.#onFinished);
    page.on(REQUEST_FAILED_EVENT, this.#onFailed);
  }

  /** 進行中の要求の数（終わりの事象が来ず、応答の後の猶予も過ぎていない要求）。 */
  get inFlight(): number {
    this.#expireGrace();
    return this.#inFlight.size;
  }

  /**
   * COV-3: 今の要求の数（`inFlight`: 進行中の数。応答の後の猶予の間を含む、`events`: 始まりと終わりの通しの数）。落ち着きの待ちの部品
   * （`src/browser/page-settling.ts` の `waitForPageSettled` の `dataActivity`）に渡す形。
   */
  dataActivity(): DataActivity {
    const inFlight = this.inFlight;
    // L6/L3-1 の続き: 口ごとの事実（`DataActivity.endpoints`。判定は `dataQuietnessOf`）。
    return {
      inFlight,
      events: this.#events,
      endpoints: {
        inFlight: [...this.#inFlight.values()].map(({ endpoint }) => endpoint),
        completed: [...this.#completedEndpoints],
        failed: [...this.#failedEndpoints],
        started: Object.fromEntries(this.#startedEndpoints),
      },
    };
  }

  /** 静かになった時刻。まだ応答を返し終えていない口への要求が進行中なら `null`（返し終えた口へのくり返しは、静まりを止めない）。 */
  quietSinceMs(): number | null {
    this.#expireGrace();
    return [...this.#inFlight.values()].some(({ endpoint }) => this.#pending(endpoint)) ? null : this.#lastEndMs;
  }

  /** REV-DQF fix round 3: 前の画面までに出た送り先（この画面で新しい送り先でない）。 */
  knownEndpoints(): ReadonlySet<string> {
    return this.#knownEndpoints?.() ?? new Set<string>();
  }

  /** REV-DQF fix round 3: この画面で出た送り先（口を読めた要求だけ）。 */
  seenEndpoints(): readonly string[] {
    return [...this.#seenEndpoints];
  }

  /** 事象の受け口を外す（何度呼んでもよい）。外した後は数えない。 */
  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#page.off(REQUEST_START_EVENT, this.#onStart);
    this.#page.off(RESPONSE_EVENT, this.#onResponse);
    this.#page.off(REQUEST_FINISHED_EVENT, this.#onFinished);
    this.#page.off(REQUEST_FAILED_EVENT, this.#onFailed);
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
 * L0（設計書 `2026-11-09-beaksight-remove-limits-design.md` 5 の 1）: `progress` は進みの見張りの口（`src/core/progress-watch.ts`。差し込み口。省略すると
 * 今のまま）。まだ読んだことのない候補の集合を読んだときだけ、中身の進みの印を付ける（同じ集合を繰り返し読んだだけ、周期的に入れ替わるだけは進みと
 * 見なさない）。見張りが段を終えたら（`signal` の abort）、待ちをやめて `TIMED_OUT` を返す。
 */
export async function waitForDiscoverySettled(
  source: QuietSource,
  readCandidateSet: CandidateSetReader,
  policy: DiscoverySettlePolicy = DISCOVERY_SETTLE_POLICY,
  progress?: Pick<ProgressSignals, 'mark' | 'signal' | 'remainingMs'>,
  /**
   * L10 の調べの直し: 読む文書が消えたか（凍結の中の文書が、止めた移動で誤りの画面に替わったなど。候補の集合は読めない）。真になったら、待たずに `TIMED_OUT`
   * を返す（呼ぶ側は読めなかったとする）。省略すると見ない。
   */
  documentGone?: () => boolean,
  /**
   * RB-8: 時刻を読み、待つ時計（テストだけが差し込む。省略は本物の時計）。読み取りの期限（`readCandidateSet` と、その待ち）は、ページを読む部品の時刻（壁の
   * 時計）に直して渡す。
   */
  clock: Clock = SYSTEM_CLOCK,
): Promise<DiscoverySettleOutcome> {
  const deadlineAtMs = clock.now() + policy.timeoutMs;
  /** 読み取りの期限（壁の時計の時刻。本物の時計では `deadlineAtMs` のまま）。 */
  const readDeadlineAtMs = (): number => (clock === SYSTEM_CLOCK ? deadlineAtMs : Date.now() + Math.max(0, deadlineAtMs - clock.now()));
  let previous: PairableRead | null = null;
  /** 最後に読み始めた時刻（失敗した読み取りを含む。読み取りの間隔を空けるため）。 */
  let lastReadStartedAtMs: number | null = null;
  /** L0: 読んだことのある候補の集合（重複を除いて並べた digest の列）。 */
  const seenSets = new Set<string>();
  /** DEF-290: まだ届いていない口の途中の要求の組の印（`dataQuietnessOf` の `mark`）と、それが最後に変わった時刻。 */
  let pendingMark: string | null = null;
  let pendingMovedAtMs = clock.now();
  /**
   * 静かになった時刻。DEF-290: まだ届いていない口の要求が残っていても、その組が変わらない（新しい要求の始まりも、まだ届いていない要求の終わりもない）まま、
   * 開いた要求の静まりの長さが過ぎたら（DEF-283 の C と同じ判定 `progressStoppedOf`）、組が最後に変わった時刻から静かだったとみなす（答えない長い要求で、
   * 読まずに見張りまで待たない）。作りの変化は、続く 2 回の読み取りの集合の比べが見る。要求の数え方の口がなければ、今のまま。
   */
  const quietSinceNow = (): number | null => {
    const quietSince = source.quietSinceMs();
    if (quietSince !== null || source.dataActivity === undefined) {
      pendingMark = null;
      return quietSince;
    }
    const now = clock.now();
    const { mark } = dataQuietnessOf(source.dataActivity());
    if (mark !== pendingMark) {
      pendingMark = mark;
      pendingMovedAtMs = now;
    }
    return progressStoppedOf(pendingMovedAtMs, now, policy.openDataRequestQuietMs) ? pendingMovedAtMs : null;
  };
  /** 候補の集合を 1 回読む（まだ読んだことのない集合なら、中身の進みの印を付ける）。 */
  const readSet = async (): Promise<readonly string[] | null> => {
    const readDeadline = readDeadlineAtMs();
    const outcome = await awaitBeforeDeadline(readCandidateSet(readDeadline), readDeadline);
    const set = outcome.status === 'FULFILLED' ? outcome.value : null;
    if (progress !== undefined && set !== null) {
      const setKey = JSON.stringify([...new Set(set)].sort());
      if (!seenSets.has(setKey)) {
        seenSets.add(setKey);
        progress.mark('BROWSER_RESPONSE');
      }
    }
    return set;
  };
  /**
   * REV-DQF の Important-B: 見張りが段を終えるまでの残りが、静かな時間の長さ（`networkQuietMs`）を切ったか（見張りの残りの長さを読める口のときだけ）。切ったら、
   * 待ちを自分で切り上げる（見張りに終えられると、画面の記録ごと失う）。
   */
  const watchEnding = (): boolean => progress?.remainingMs !== undefined && progress.remainingMs() <= policy.networkQuietMs;
  /**
   * REV-DQF の Important-B: 静まり（DEF-290）で読んだときの、まだ届いていない口の途中の要求の組の印。見張りの中では、その組が答える（変わる）まで、読まずに
   * 待ち、答えたら読み直す（答えで描かれる候補を読み落とさない）。答えが見張りの中に来なければ、切り上げて `TIMED_OUT`（読み切れなかった理由
   * `INCOMPLETE_SETTLE_TIMEOUT` を呼ぶ側が付ける）。見張りの外（残りを読めない口）では、DEF-290 のとおり静まりで読んで終える。
   */
  let awaitingAnswerOf: string | null = null;
  /**
   * REV-DQF fix round 3: まだ届いていない要求に、この画面で新しい送り先（前の画面までに出ていない口）へのものがあるか。判定は DEF-283 の B と同じ 1 か所
   * （`dataQuietnessOf`。前の画面までに出た口を、一度終わった口と同じに扱って渡す）。要求の数え方の口がなければ、あるとみなす。
   */
  const newDestinationPending = (): boolean => {
    const data = source.dataActivity?.();
    if (data === undefined || data.endpoints === undefined) return true;
    const known = source.knownEndpoints?.() ?? new Set<string>();
    return dataQuietnessOf({ ...data, endpoints: { ...data.endpoints, completed: [...data.endpoints.completed, ...known] } }).pending > 0;
  };
  while (clock.now() < deadlineAtMs) {
    if (progress?.signal.aborted === true || documentGone?.() === true) {
      return TIMED_OUT;
    }
    const quietSince = quietSinceNow();
    if (awaitingAnswerOf !== null && source.quietSinceMs() === null && pendingMark === awaitingAnswerOf) {
      if (watchEnding()) {
        await readSet();
        return TIMED_OUT;
      }
      await clock.sleep(Math.max(0, Math.min(policy.pollIntervalMs, deadlineAtMs - clock.now())));
      continue;
    }
    if (awaitingAnswerOf !== null) {
      // 残っていた要求が答えた（組が変わった）。読み直す。
      awaitingAnswerOf = null;
      previous = null;
    }
    const now = clock.now();
    const quietLongEnough = quietSince !== null && now - quietSince >= policy.networkQuietMs;
    const spacedEnough = lastReadStartedAtMs === null || now - lastReadStartedAtMs >= policy.probeIntervalMs;
    if (quietSince === null || !quietLongEnough || !spacedEnough) {
      if (watchEnding()) {
        await readSet();
        return TIMED_OUT;
      }
      await clock.sleep(Math.max(0, Math.min(policy.pollIntervalMs, deadlineAtMs - now)));
      continue;
    }
    const startedAtMs = clock.now();
    lastReadStartedAtMs = startedAtMs;
    const set = await readSet();
    // 読み取りの間も静かだったか（読み取りの前と後で、静かになった時刻が変わらない）。
    const quietThroughout = quietSinceNow() === quietSince;
    if (set === null || !quietThroughout) {
      previous = null;
      continue;
    }
    if (previous !== null && quietSince <= previous.startedAtMs && sameSet(previous.set, set) && clock.now() < deadlineAtMs) {
      // REV-DQF の Important-B: 静まりで読んだ（まだ届いていない要求が残る）ときは、見張りの中なら、その要求が答えるまで待って読み直す。fix round 3: 待つのは、
      // 残った要求に、この画面で新しい送り先へのものがあるときだけ（ほかの画面でも出た送り先への答えない要求は待たない）。
      if (source.quietSinceMs() === null && progress?.remainingMs !== undefined && newDestinationPending()) {
        awaitingAnswerOf = pendingMark;
        continue;
      }
      return SETTLED;
    }
    previous = { set, startedAtMs };
  }
  return TIMED_OUT;
}

/** L6/L3-1 の続き（T9）: 落ち着きの待ちの子の見張りの指定。 */
export interface WatchedSettleOptions {
  /** 子の見張りの反応なしの長さ（ms。1 画面の見張りと同じ長さを渡す。省略すると `PROGRESS_WATCH_QUIET_LIMIT_MS`）。 */
  readonly quietLimitMs?: number | undefined;
  /**
   * L10 の調べの直し: 読む文書が消えたか（誤りの画面に替わったなど）。真になったら、子の見張りの長さを待たずに待ちを終える。消えた文書では候補の集合が
   * 読めず、新しい集合が出ないので、子の見張りは長さいっぱい待っていた（その間に Chromium が page を閉じ、Guard が印のない閉じとして止めた）。
   */
  readonly documentGone?: (() => boolean) | undefined;
  /**
   * REV-DQF の Important-B: 外側の 1 画面の見張りの口（残りの長さを読む。子の見張りより先に終わりうるので、待ちを切り上げる時機は、両方の残りの短い方で決める）。
   */
  readonly outer?: Pick<ProgressSignals, 'remainingMs'> | undefined;
}

/**
 * L6/L3-1 の続き（T9。設計者の判断 2026-11-10 の案 A）: 落ち着きの待ちを、子の進みの見張り（`watchProgress`）で包んで待つ（例外を投げない）。
 * - 時間の上限（`policy.timeoutMs`。`DISCOVERY_SETTLE_TIMEOUT_MS`）は使わない。待ちの条件（静かな時間と、2 回続けて同じ候補の集合）は今どおり。
 * - 子の見張りは、まだ読んだことのない候補の集合を読んだときだけ進みに数える（`waitForDiscoverySettled` の `progress`）。新しい集合が見張りの長さの間
 *   出なければ（入れ替わり続けるだけの画面など）、待ちだけを終えて `TIMED_OUT` を返す（呼ぶ側は `INCOMPLETE_SETTLE_TIMEOUT` を付けて候補を読む。候補を
 *   読まずに進めない）。
 * - 読み取り（CDP の命令）は、外側の 1 画面の見張りの進みにも数える（`cdp-session.ts`）。子の見張りが待ちを必ず終えるので、外側の見張りが待ち続けることはない。
 */
export async function waitForDiscoverySettledWatched(
  source: QuietSource,
  readCandidateSet: CandidateSetReader,
  policy: DiscoverySettlePolicy = DISCOVERY_SETTLE_POLICY,
  options: WatchedSettleOptions = {},
): Promise<DiscoverySettleOutcome> {
  const watched = await watchProgress(
    (signals) => {
      const outerRemaining = options.outer?.remainingMs;
      const remainingMs = (): number => Math.min(signals.remainingMs?.() ?? Number.POSITIVE_INFINITY, outerRemaining?.() ?? Number.POSITIVE_INFINITY);
      return waitForDiscoverySettled(source, readCandidateSet, { ...policy, timeoutMs: OPEN_ENDED_STAGE_MS }, { ...signals, remainingMs }, options.documentGone);
    },
    { quietLimitMs: options.quietLimitMs },
  );
  return watched.status === 'FULFILLED' ? watched.value : TIMED_OUT;
}
