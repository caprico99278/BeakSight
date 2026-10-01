import {
  CRAWL_URL_STATES,
  INCOMPLETE_REASON_CODES,
  type CrawlUrlState,
  type IncompleteReason,
  type IncompleteReasonCode,
  type PageAuditStatus,
  type PageId,
} from '../core/contracts.js';
import type { NormalizedHttpUrlEvidence } from '../core/evidence-types.js';
import { isNonNegativeSafeInteger } from '../core/guards.js';
import { isPageId } from '../core/ids.js';
import { deepFreeze } from '../core/immutable.js';
import { CrawlQueue } from '../crawl/crawl-queue.js';
import { normalizeUrl } from '../crawl/normalize-url.js';
import type { IdAllocator } from './id-allocator.js';

/**
 * Run Coordinator が URL ごとに持つ状態の閉じた一覧（Task 14〜17 の設計書 5.1、5.6.3。各状態の意味は `src/core/contracts.ts` を見る）。
 * 値の一覧は、再開のための保存のスキーマの enum と一致させるため、core に置く（共通部品台帳 2.2。R2 の Blocker B2）。
 * 既存の import 元を保つため、同じ名前で export し直す。
 */
export { CRAWL_URL_STATES, type CrawlUrlState } from '../core/contracts.js';

/** 1つの URL の記録（発見の順に並ぶ）。 */
export interface CrawlUrlEntry {
  readonly url: NormalizedHttpUrlEvidence;
  /** 開始の URL を0とし、リンクをたどるたびに1増える深さ。 */
  readonly depth: number;
  /** 発見したときに採番したページの ID。 */
  readonly pageId: PageId;
  readonly state: CrawlUrlState;
  /** `SKIPPED` にした理由。`SKIPPED` でなければ `null`。 */
  readonly skipReason: IncompleteReason | null;
}

/** `discover` の結果。`KNOWN` は、すでに発見していた URL（何もしない）。 */
export type CrawlDiscovery = 'QUEUED' | 'SKIPPED' | 'KNOWN';

/** 巡回の記録の状態（`snapshot` の結果）。発見の順の URL ごとの記録で、JSON にできる凍結した値。 */
export interface CrawlFrontierSnapshot {
  readonly entries: readonly CrawlUrlEntry[];
}

/**
 * 保存から読んだ1つの URL の記録（`CrawlFrontier.restore` の入力）。JSON から読んだ値なので、型の印のない文字列で受け取り、
 * `restore` が確かめてから印を付ける。`CrawlUrlEntry` はこの形にそのまま当てはまる。
 */
export interface StoredCrawlUrlEntry {
  readonly url: string;
  readonly depth: number;
  readonly pageId: string;
  readonly state: string;
  readonly skipReason: { readonly code: string; readonly detail: string | null } | null;
}

/** 保存から読んだ巡回の記録（`CrawlFrontier.restore` の入力）。`CrawlFrontierSnapshot` はこの形にそのまま当てはまる。 */
export interface StoredCrawlFrontierSnapshot {
  readonly entries: readonly StoredCrawlUrlEntry[];
}

/** `CrawlFrontier.restore` の設定。`maxDepth` と `allowedQueryParameters` は、Run の設定から取る。 */
export interface CrawlFrontierRestoreOptions {
  readonly maxDepth: number;
  /** 作り直した後の `discover` で、新しい URL のページの ID を採番する採番器。 */
  readonly allocator: IdAllocator;
  /** URL の正規化で残す query の引数の名前（`config.crawl.allowedQueryParameters`）。記録の URL が正規形かを確かめるのに使う。 */
  readonly allowedQueryParameters: ReadonlySet<string>;
  /** この理由のコードの `SKIPPED` を、`QUEUED` に戻す（待ち行列に戻す）。 */
  readonly requeueSkipReasonCodes: ReadonlySet<IncompleteReasonCode>;
}

/** 深さの上限を超えた URL の理由（設計書 5.6.3）。 */
const MAX_DEPTH_REACHED_REASON: IncompleteReason = Object.freeze({ code: 'MAX_DEPTH_REACHED', detail: null });

interface MutableEntry {
  readonly url: NormalizedHttpUrlEvidence;
  readonly depth: number;
  readonly pageId: PageId;
  state: CrawlUrlState;
  skipReason: IncompleteReason | null;
}

const isCrawlUrlState = (value: unknown): value is CrawlUrlState =>
  typeof value === 'string' && (CRAWL_URL_STATES as readonly string[]).includes(value);

const isIncompleteReasonCode = (value: unknown): value is IncompleteReasonCode =>
  typeof value === 'string' && (INCOMPLETE_REASON_CODES as readonly string[]).includes(value);

/** 深さの上限による `SKIPPED` か（`discover` は、この URL を待ち行列に入れない）。 */
const isSkippedByDepthLimit = (entry: MutableEntry): boolean =>
  entry.state === 'SKIPPED' && entry.skipReason?.code === MAX_DEPTH_REACHED_REASON.code;

/**
 * 保存から読んだ1つの記録を確かめて、作り直した記録にする（`CrawlFrontier.restore`。中断した Run の再開の設計書 4.2）。
 * - URL は、正規化の owner の `normalizeUrl` で正規化し直し、前と後が同じものだけを受け付ける。型の印は `normalizeUrl` の結果のものを使う。
 *   受け付けない URL は、認証情報を含むことがあるので、エラーの文に入れない。
 * - `AUDITING` と、理由のコードが `requeueSkipReasonCodes` にある `SKIPPED` は、`QUEUED`（理由は `null`）に戻す。
 * - 深さが `maxDepth` を超えるのは、深さの上限による `SKIPPED` だけである（`discover` と同じ）。
 * 不正な記録は `RangeError` を投げる。
 */
const restoreEntry = (stored: StoredCrawlUrlEntry, index: number, options: CrawlFrontierRestoreOptions): MutableEntry => {
  const invalid = (problem: string): RangeError => new RangeError(`crawl frontier snapshot entry ${index}: ${problem}`);
  const normalized = typeof stored.url === 'string' ? normalizeUrl(stored.url, stored.url, options.allowedQueryParameters) : undefined;
  if (normalized === undefined || !normalized.ok || normalized.url !== stored.url) {
    throw invalid('URL is not in the normalized form');
  }
  const { pageId, depth, state, skipReason } = stored;
  if (!isPageId(pageId)) {
    throw invalid('page ID is not in the page ID format');
  }
  if (!isNonNegativeSafeInteger(depth)) {
    throw invalid('depth must be a non-negative safe integer');
  }
  if (!isCrawlUrlState(state)) {
    throw invalid(`unsupported crawl URL state: ${String(state)}`);
  }
  if (state === 'DISCOVERED') {
    throw invalid('DISCOVERED is a transient state and is never stored');
  }
  let reason: IncompleteReason | null = null;
  if (state === 'SKIPPED') {
    if (skipReason === null || typeof skipReason !== 'object') {
      throw invalid('SKIPPED needs a skip reason');
    }
    if (!isIncompleteReasonCode(skipReason.code)) {
      throw invalid(`unsupported skip reason code: ${String(skipReason.code)}`);
    }
    if (skipReason.detail !== null && typeof skipReason.detail !== 'string') {
      throw invalid('skip reason detail must be a string or null');
    }
    reason = Object.freeze({ code: skipReason.code, detail: skipReason.detail });
  } else if (skipReason !== null) {
    throw invalid(`only SKIPPED has a skip reason (state ${state})`);
  }
  const requeued = state === 'AUDITING' || (reason !== null && options.requeueSkipReasonCodes.has(reason.code));
  const entry: MutableEntry = {
    url: normalized.url,
    depth,
    pageId,
    state: requeued ? 'QUEUED' : state,
    skipReason: requeued ? null : reason,
  };
  if (depth > options.maxDepth && !isSkippedByDepthLimit(entry)) {
    throw invalid(`depth ${depth} exceeds the max depth ${options.maxDepth} without ${MAX_DEPTH_REACHED_REASON.code}`);
  }
  return entry;
};

/**
 * Run の BFS の URL の状態、深さ、ページの ID を持つ（Task 14〜17 の設計書 5.6.3）。
 * - FIFO と重複の排除は `CrawlQueue` が受け持つ。状態と深さは、ここが URL ごとに持つ。
 * - ページの ID は、URL を初めて発見したときに、Run の採番器で採番する（発見の順と ID が一致し、決定論的になる）。
 * - 深さが `maxDepth` を超える URL は、キューに入れずに `SKIPPED`（理由 `MAX_DEPTH_REACHED`）にする。
 * - 状態の遷移は、`QUEUED` → `AUDITING` → `AUDITED`・`FAILED` と、まだ終えていない URL の `SKIPPED` だけを受け付ける。
 *   それ以外の遷移は、呼び出し側の誤りとして `Error` を投げる。
 * - 中断した Run の再開のために、記録を `snapshot` で取り出し、`CrawlFrontier.restore` で新しい frontier に作り直せる。
 */
export class CrawlFrontier {
  /** 待ち行列。`CrawlFrontier.restore` が、作り直した待ち行列に置き換えるときだけ代入し直す。 */
  #queue = new CrawlQueue();
  readonly #entries = new Map<string, MutableEntry>();
  readonly #maxDepth: number;
  readonly #allocator: IdAllocator;

  constructor(maxDepth: number, allocator: IdAllocator) {
    if (!isNonNegativeSafeInteger(maxDepth)) {
      throw new RangeError('crawl max depth must be a non-negative safe integer');
    }
    this.#maxDepth = maxDepth;
    this.#allocator = allocator;
  }

  /**
   * `snapshot` で取り出した記録（保存から読んだ値）から、新しい frontier を作る（中断した Run の再開の設計書 4.2）。
   * - 記録は、発見の順のまま作り直す。`AUDITING` と、理由のコードが `requeueSkipReasonCodes` にある `SKIPPED` は、`QUEUED` に戻す。
   * - 待ち行列は、`QUEUED` の記録を発見の順に並べたものにする。今の作りでは、待ち行列の順は発見の順の `QUEUED` と一致する
   *   （`discover` が発見の順に入れ、`next` が先頭から出すため）。受け付けたことのある URL は、深さの上限による `SKIPPED` を除く、
   *   すべての記録の URL にする（`discover` は、深さを超えた URL を待ち行列に入れない）。
   * - その後の `discover` は、`allocator` で新しい URL のページの ID を採番し、`maxDepth` で深さを確かめる。
   * 不正な記録（`restoreEntry`）は `RangeError`、同じ URL と同じページの ID が2回ある場合は `Error` を投げる。
   */
  static restore(snapshot: StoredCrawlFrontierSnapshot, options: CrawlFrontierRestoreOptions): CrawlFrontier {
    const frontier = new CrawlFrontier(options.maxDepth, options.allocator);
    const pageIds = new Set<PageId>();
    snapshot.entries.forEach((stored, index) => {
      const entry = restoreEntry(stored, index, options);
      if (frontier.#entries.has(entry.url)) {
        throw new Error(`crawl frontier snapshot lists a URL twice: ${entry.url}`);
      }
      if (pageIds.has(entry.pageId)) {
        throw new Error(`crawl frontier snapshot lists a page ID twice: ${entry.pageId}`);
      }
      pageIds.add(entry.pageId);
      frontier.#entries.set(entry.url, entry);
    });
    const entries = [...frontier.#entries.values()];
    frontier.#queue = CrawlQueue.restore({
      pending: entries.filter((entry) => entry.state === 'QUEUED').map(({ url, depth }) => ({ url, depth })),
      seenUrls: entries.filter((entry) => !isSkippedByDepthLimit(entry)).map((entry) => entry.url),
    });
    return frontier;
  }

  /** すべての URL の記録（発見の順。`entries` と同じ形）。深く凍結した、JSON にできる値。frontier は変えない。 */
  snapshot(): CrawlFrontierSnapshot {
    return deepFreeze({
      entries: [...this.#entries.values()].map(({ url, depth, pageId, state, skipReason }) => ({
        url,
        depth,
        pageId,
        state,
        skipReason: skipReason === null ? null : { code: skipReason.code, detail: skipReason.detail },
      })),
    });
  }

  /** 発見した URL の数（開始の URL を含む。設計書 5.6.5 の `discoveredPageCount`）。 */
  get discoveredCount(): number {
    return this.#entries.size;
  }

  /**
   * URL を深さ `depth` で発見する。初めての URL なら、ページの ID を採番し、深さが上限以内ならキューに入れる（`QUEUED`）。
   * 上限を超えるなら `SKIPPED`（`MAX_DEPTH_REACHED`）にする。すでに発見していた URL は、何もしない（`KNOWN`）。
   * BFS では、先に発見した深さが最も浅いので、後から浅い深さで発見し直すことはない。
   */
  discover(url: NormalizedHttpUrlEvidence, depth: number): CrawlDiscovery {
    if (!isNonNegativeSafeInteger(depth)) {
      throw new RangeError('crawl depth must be a non-negative safe integer');
    }
    if (this.#entries.has(url)) {
      return 'KNOWN';
    }
    const entry: MutableEntry = { url, depth, pageId: this.#allocator.allocatePageId(), state: 'DISCOVERED', skipReason: null };
    this.#entries.set(url, entry);
    if (depth > this.#maxDepth) {
      entry.state = 'SKIPPED';
      entry.skipReason = MAX_DEPTH_REACHED_REASON;
      return 'SKIPPED';
    }
    if (!this.#queue.enqueue({ url, depth })) {
      throw new Error(`crawl queue rejected a newly discovered URL: ${url}`);
    }
    entry.state = 'QUEUED';
    return 'QUEUED';
  }

  /** 次に監査する URL（FIFO）。キューが空なら `undefined`。状態は変えない（`QUEUED` のまま）。 */
  next(): CrawlUrlEntry | undefined {
    const candidate = this.#queue.dequeue();
    return candidate === undefined ? undefined : this.#snapshot(this.#entry(candidate.url));
  }

  markAuditing(url: NormalizedHttpUrlEvidence): void {
    this.#transition(url, ['QUEUED'], 'AUDITING');
  }

  /** 監査を終えた。ページの状態が `FAILED` なら `FAILED`、それ以外（`AUDITED`、`PARTIAL`、`SKIPPED`）は `AUDITED` にする。 */
  markFinished(url: NormalizedHttpUrlEvidence, pageStatus: PageAuditStatus): void {
    this.#transition(url, ['AUDITING'], pageStatus === 'FAILED' ? 'FAILED' : 'AUDITED');
  }

  /** まだ終えていない URL（`QUEUED` か `AUDITING`）を、`reason` で `SKIPPED` にする。 */
  markSkipped(url: NormalizedHttpUrlEvidence, reason: IncompleteReason): void {
    this.#transition(url, ['QUEUED', 'AUDITING'], 'SKIPPED').skipReason = reason;
  }

  /** キューに残っている URL を、発見の順に取り出す（残りをすべて `SKIPPED` にするため）。 */
  drain(): CrawlUrlEntry[] {
    const drained: CrawlUrlEntry[] = [];
    for (let entry = this.next(); entry !== undefined; entry = this.next()) {
      drained.push(entry);
    }
    return drained;
  }

  /** すべての URL の記録（発見の順）。 */
  entries(): CrawlUrlEntry[] {
    return [...this.#entries.values()].map((entry) => this.#snapshot(entry));
  }

  #entry(url: string): MutableEntry {
    const entry = this.#entries.get(url);
    if (entry === undefined) {
      throw new Error(`crawl URL was not discovered: ${url}`);
    }
    return entry;
  }

  #transition(url: string, from: readonly CrawlUrlState[], to: CrawlUrlState): MutableEntry {
    const entry = this.#entry(url);
    if (!from.includes(entry.state)) {
      throw new Error(`invalid crawl URL state transition: ${entry.state} -> ${to}`);
    }
    entry.state = to;
    return entry;
  }

  #snapshot(entry: MutableEntry): CrawlUrlEntry {
    return Object.freeze({ ...entry });
  }
}
