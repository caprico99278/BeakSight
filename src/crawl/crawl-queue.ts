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

/** OP-I（I2）: 受け付けの指定。`preferred` の候補は、印のない候補より先に取り出す（操作さがしの段だけが渡す）。 */
export interface CrawlEnqueueOptions {
  readonly preferred?: boolean;
}

/**
 * 単一コンシューマ向けFIFOキュー。巡回が続く間、受理した全URLを記憶し続ける。
 * 中断した Run の再開のために、状態を `snapshot` で取り出し、`CrawlQueue.restore` で新しい待ち行列に作り直せる。
 * OP-I（I2。設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.5）: 先に読む印（`preferred`）のある候補は、まだ取り出していない印のある候補の後、
 * 印のない候補の前に入れる（印のある候補どうし・ない候補どうしは受け付けた順）。印を渡さなければ今までどおりの FIFO。`snapshot` の `pending` は取り出す順の
 * まま。`restore` で作り直した待ち行列は、印を持たない（印を渡すのは、保存も再開もしない操作さがしの段だけ）。
 */
export class CrawlQueue {
  readonly #pending: CrawlCandidate[] = [];
  readonly #seenUrls = new Set<NormalizedHttpUrl>();
  /** `#pending` の先頭から数えた、印のある候補の数（印のある候補は、いつも先頭に並ぶ）。 */
  #preferredCount = 0;

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

  enqueue(candidate: CrawlCandidate, options: CrawlEnqueueOptions = {}): boolean {
    if (!isNonNegativeSafeInteger(candidate.depth)) {
      return false;
    }

    if (this.#seenUrls.has(candidate.url)) {
      return false;
    }

    this.#seenUrls.add(candidate.url);
    if (options.preferred === true) {
      this.#pending.splice(this.#preferredCount, 0, freezeCandidate(candidate));
      this.#preferredCount += 1;
    } else {
      this.#pending.push(freezeCandidate(candidate));
    }
    return true;
  }

  dequeue(): CrawlCandidate | undefined {
    const candidate = this.#pending.shift();
    if (candidate !== undefined && this.#preferredCount > 0) {
      this.#preferredCount -= 1;
    }
    return candidate;
  }
}
