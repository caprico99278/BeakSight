import { isNonNegativeSafeInteger } from '../core/guards.js';
import type { NormalizedHttpUrl } from './normalize-url.js';

export interface CrawlCandidate {
  readonly url: NormalizedHttpUrl;
  readonly depth: number;
}

/** 待ち行列の状態（未処理の候補の順と、受け付けたことのある URL の一覧）。JSON にできる値。 */
export interface CrawlQueueSnapshot {
  readonly pending: readonly CrawlCandidate[];
  readonly seenUrls: readonly NormalizedHttpUrl[];
}

/** 呼び出し側の値を写して凍結した候補（呼び出し側が後から値を変えても、待ち行列の中身は変わらない）。 */
const freezeCandidate = (candidate: CrawlCandidate): CrawlCandidate =>
  Object.freeze({ url: candidate.url, depth: candidate.depth }) as CrawlCandidate;

/**
 * 単一コンシューマ向けFIFOキュー。巡回が続く間、受理した全URLを記憶し続ける。
 * 中断した Run の再開のために、状態を `snapshot` で取り出し、`CrawlQueue.restore` で新しい待ち行列に作り直せる。
 */
export class CrawlQueue {
  readonly #pending: CrawlCandidate[] = [];
  readonly #seenUrls = new Set<NormalizedHttpUrl>();

  /**
   * `snapshot` で取り出した状態から、新しい待ち行列を作る。作った待ち行列は、`pending` の順に候補を取り出し、
   * `seenUrls` の URL を受け付けない（取り出した後も含めて、重複を排除し続ける）。
   * 深さが0以上の安全な整数でなければ `RangeError`、`pending` の URL が `seenUrls` にない場合と、同じ URL が2回ある場合は `Error` を投げる。
   */
  static restore(snapshot: CrawlQueueSnapshot): CrawlQueue {
    const queue = new CrawlQueue();
    for (const url of snapshot.seenUrls) {
      if (queue.#seenUrls.has(url)) {
        throw new Error(`crawl queue snapshot lists an accepted URL twice: ${url}`);
      }
      queue.#seenUrls.add(url);
    }
    const pendingUrls = new Set<NormalizedHttpUrl>();
    for (const candidate of snapshot.pending) {
      if (!isNonNegativeSafeInteger(candidate.depth)) {
        throw new RangeError('crawl queue snapshot depth must be a non-negative safe integer');
      }
      if (!queue.#seenUrls.has(candidate.url)) {
        throw new Error(`crawl queue snapshot has a pending URL that was not accepted: ${candidate.url}`);
      }
      if (pendingUrls.has(candidate.url)) {
        throw new Error(`crawl queue snapshot lists a pending URL twice: ${candidate.url}`);
      }
      pendingUrls.add(candidate.url);
      queue.#pending.push(freezeCandidate(candidate));
    }
    return queue;
  }

  /** 未処理の候補（取り出す順）と、受け付けたことのある URL（受け付けた順）。凍結した、JSON にできる値。待ち行列は変えない。 */
  snapshot(): CrawlQueueSnapshot {
    return Object.freeze({ pending: Object.freeze([...this.#pending]), seenUrls: Object.freeze([...this.#seenUrls]) });
  }

  enqueue(candidate: CrawlCandidate): boolean {
    if (!isNonNegativeSafeInteger(candidate.depth)) {
      return false;
    }

    if (this.#seenUrls.has(candidate.url)) {
      return false;
    }

    this.#seenUrls.add(candidate.url);
    this.#pending.push(freezeCandidate(candidate));
    return true;
  }

  dequeue(): CrawlCandidate | undefined {
    return this.#pending.shift();
  }
}
