import { isNonNegativeSafeInteger } from '../core/guards.js';
import type { NormalizedHttpUrl } from './normalize-url.js';

export interface CrawlCandidate {
  readonly url: NormalizedHttpUrl;
  readonly depth: number;
}

/** 単一コンシューマ向けFIFOキュー。巡回が続く間、受理した全URLを記憶し続ける。 */
export class CrawlQueue {
  readonly #pending: CrawlCandidate[] = [];
  readonly #seenUrls = new Set<string>();

  enqueue(candidate: CrawlCandidate): boolean {
    if (!isNonNegativeSafeInteger(candidate.depth)) {
      return false;
    }

    if (this.#seenUrls.has(candidate.url)) {
      return false;
    }

    const snapshot = Object.freeze({ url: candidate.url, depth: candidate.depth }) as CrawlCandidate;
    this.#seenUrls.add(candidate.url);
    this.#pending.push(snapshot);
    return true;
  }

  dequeue(): CrawlCandidate | undefined {
    return this.#pending.shift();
  }
}
