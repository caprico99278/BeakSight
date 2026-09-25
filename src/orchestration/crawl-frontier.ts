import type { IncompleteReason, PageAuditStatus, PageId } from '../core/contracts.js';
import type { NormalizedHttpUrlEvidence } from '../core/evidence-types.js';
import { isNonNegativeSafeInteger } from '../core/guards.js';
import { CrawlQueue } from '../crawl/crawl-queue.js';
import type { IdAllocator } from './id-allocator.js';

/**
 * Run Coordinator が URL ごとに持つ状態の閉じた一覧（Task 14〜17 の設計書 5.1、5.6.3）。
 * - `DISCOVERED`: 発見した（ページの ID を採番した）。
 * - `QUEUED`: キューに入れた。
 * - `AUDITING`: 監査している。
 * - `AUDITED`: 監査を終えた（ページの状態が `AUDITED` か `PARTIAL`）。
 * - `SKIPPED`: 監査しなかった（上限など）。
 * - `FAILED`: 監査を終えたが、ページの状態が `FAILED` だった。
 */
export const CRAWL_URL_STATES = Object.freeze(['DISCOVERED', 'QUEUED', 'AUDITING', 'AUDITED', 'SKIPPED', 'FAILED'] as const);
export type CrawlUrlState = (typeof CRAWL_URL_STATES)[number];

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

/** 深さの上限を超えた URL の理由（設計書 5.6.3）。 */
const MAX_DEPTH_REACHED_REASON: IncompleteReason = Object.freeze({ code: 'MAX_DEPTH_REACHED', detail: null });

interface MutableEntry {
  readonly url: NormalizedHttpUrlEvidence;
  readonly depth: number;
  readonly pageId: PageId;
  state: CrawlUrlState;
  skipReason: IncompleteReason | null;
}

/**
 * Run の BFS の URL の状態、深さ、ページの ID を持つ（Task 14〜17 の設計書 5.6.3）。
 * - FIFO と重複の排除は `CrawlQueue` が受け持つ。状態と深さは、ここが URL ごとに持つ。
 * - ページの ID は、URL を初めて発見したときに、Run の採番器で採番する（発見の順と ID が一致し、決定論的になる）。
 * - 深さが `maxDepth` を超える URL は、キューに入れずに `SKIPPED`（理由 `MAX_DEPTH_REACHED`）にする。
 * - 状態の遷移は、`QUEUED` → `AUDITING` → `AUDITED`・`FAILED` と、まだ終えていない URL の `SKIPPED` だけを受け付ける。
 *   それ以外の遷移は、呼び出し側の誤りとして `Error` を投げる。
 */
export class CrawlFrontier {
  readonly #queue = new CrawlQueue();
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
