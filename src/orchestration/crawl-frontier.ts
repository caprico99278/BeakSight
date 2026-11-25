import {
  CRAWL_URL_STATES,
  PAGE_REFERENCE_DEPTHS,
  type PageReferenceDepth,
  isIncompleteReasonCode,
  isIncompleteReasonDetail,
  type CrawlUrlState,
  type IncompleteReason,
  type IncompleteReasonCode,
  type PageAuditStatus,
  type PageId,
} from '../core/contracts.js';
import type { NormalizedHttpUrlEvidence } from '../core/evidence-types.js';
import { isNonNegativeSafeInteger } from '../core/guards.js';
import { createSha256Fingerprint, isPageId, isSha256Fingerprint } from '../core/ids.js';
import { deepFreeze } from '../core/immutable.js';
import type { CrawlEnqueueOptions } from '../crawl/crawl-queue.js';
import { normalizeUrl } from '../crawl/normalize-url.js';
import { CoverageQueue, type CoverageQueueSnapshot } from '../discovery/coverage-queue.js';
import { stateLocationKeyOf } from '../discovery/state-keys.js';
import type { IdAllocator } from './id-allocator.js';
import { SITE_UNAVAILABLE_SKIP_REASON } from './site-availability.js';

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

/**
 * 巡回の記録の状態（`snapshot` の結果）。発見の順の URL ごとの記録で、JSON にできる凍結した値。
 * COV-4: 待ち行列の書き出し（`CoverageQueue.snapshot`）も持つ。前の版の保存にはない（`restore` が記録から読み替える）。
 */
export interface CrawlFrontierSnapshot {
  readonly entries: readonly CrawlUrlEntry[];
  readonly coverage?: CoverageQueueSnapshot;
  /** COV-4 の区切り 3: 監査した開いた状態の構造の鍵（受け付けた順）。前の版の保存にはない（空の集合として読む）。 */
  readonly openedStructureKeys?: readonly string[];
  /** COV-4 の区切り 3（入れ子の開いた状態）: 開いた状態の中で押した組（受け付けた順）。前の版の保存にはない（空として読む）。 */
  readonly openedPresses?: readonly OpenedPressKey[];
  /** DUP: 同じ作りの 1 回目と、点検を終えた画面の中身の表（受け付けた順）。前の版の保存にはない（空として読む）。 */
  readonly pageReferences?: readonly PageReferenceRecord[];
}

/**
 * DUP（設計書 `2026-11-18-beaksight-same-structure-pages-design.md` 2 章）: 点検を終えた画面の、作りの鍵と中身の要約。`FULL` はしっかり点検した画面（作りの鍵の
 * 最初の `FULL` が 1 回目）、`LIGHT` は軽い点検の画面（中身が同じ画面を省く相手にだけなる）。
 */
export interface PageReferenceRecord {
  readonly templateKey: string;
  readonly pageId: PageId;
  readonly depth: PageReferenceDepth;
  readonly contentDigest: string | null;
}

const isPageReferenceRecord = (value: unknown): value is PageReferenceRecord => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { templateKey, pageId, depth, contentDigest } = value as Record<string, unknown>;
  return typeof templateKey === 'string' && isSha256Fingerprint(templateKey) && typeof pageId === 'string' && isPageId(pageId)
    && (PAGE_REFERENCE_DEPTHS as readonly unknown[]).includes(depth) && (contentDigest === null || (typeof contentDigest === 'string' && isSha256Fingerprint(contentDigest)));
};

/** COV-4 の区切り 3: 開いた状態の中で押す組（その状態の構造の鍵、候補の ID、同じ ID の中の順番）。 */
export interface OpenedPressKey {
  readonly structureKey: string;
  readonly candidateId: string;
  readonly ordinal: number;
}

const openedPressKeyText = (key: OpenedPressKey): string => JSON.stringify([key.structureKey, key.candidateId, key.ordinal]);

const isOpenedPressKey = (value: unknown): value is OpenedPressKey => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { structureKey, candidateId, ordinal } = value as Record<string, unknown>;
  return typeof structureKey === 'string' && isSha256Fingerprint(structureKey) && typeof candidateId === 'string' && candidateId.length > 0
    && isNonNegativeSafeInteger(ordinal);
};

/** COV-4: 読んだページから出た辺（見るだけの点検の区切り 1 は、リンクと同じ Origin の frame）。 */
export interface CrawlPageEdge {
  /** COV-4 の区切り 3: 操作で文書が替わらずに URL が変わった辺（`SPA_ROUTE`・`QUERY_CHANGE`）も入る。 */
  readonly kind: 'LINK' | 'FRAME' | 'SPA_ROUTE' | 'QUERY_CHANGE';
  readonly url: NormalizedHttpUrlEvidence;
}

/** COV-4: 読んだページの事実（`completePage` の入力）。 */
export interface CrawlPageOutcome {
  /** 構造の鍵（`stateStructureKeyOf` の digest。読めなかったページは `UNREAD_PAGE_STRUCTURE_KEY`）。 */
  readonly structureKey: string;
  readonly edges: readonly CrawlPageEdge[];
}

/** COV-4: 読めなかった（監査を終えられなかった・飛ばした）ページの構造の鍵。 */
export const UNREAD_PAGE_STRUCTURE_KEY = createSha256Fingerprint('beaksight-audit-unread-page/1');

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
  /** COV-4: 待ち行列の書き出し（JSON から読んだ値。`CoverageQueue.restore` が確かめる）。前の版の保存にはない。 */
  readonly coverage?: unknown;
  /** COV-4 の区切り 3: 監査した開いた状態の構造の鍵（JSON から読んだ値。digest でない値は `RangeError`）。前の版の保存にはない。 */
  readonly openedStructureKeys?: unknown;
  /** COV-4 の区切り 3: 開いた状態の中で押した組（JSON から読んだ値。形の違う値は `RangeError`）。前の版の保存にはない。 */
  readonly openedPresses?: unknown;
  /** DUP: 同じ作りの 1 回目と、点検を終えた画面の中身の表（JSON から読んだ値。形の違う値は `RangeError`）。前の版の保存にはない。 */
  readonly pageReferences?: unknown;
}

/** `CrawlFrontier.restore` の設定。`maxDepth` と `allowedQueryParameters` は、Run の設定から取る。 */
export interface CrawlFrontierRestoreOptions {
  /** L14: 深さの上限（`undefined` は上限なし。利用者が指定したときだけ）。 */
  readonly maxDepth: number | undefined;
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
  /** COV-4: 待ち行列の状態の ID（場所の鍵。`stateIdOfUrl`）。 */
  readonly stateId: string;
}

/**
 * COV-4: URL の待ち行列の状態の ID（場所の鍵。最上位の文書・開いた枠なし）。frame の文書も、そのページの URL を直に読むので、同じ URL のページと同じ状態に
 * する（同じ文書を 2 回読まない）。正規化した URL は、秘密に見える名前の query を持たない（`normalizeUrl`）。場所の鍵にできない URL は、呼び出し側の誤り。
 */
const stateIdOfUrl = (url: NormalizedHttpUrlEvidence): string => {
  const location = stateLocationKeyOf({ url, frame: null, openedRegion: null });
  if (!location.ok) {
    throw new Error(`crawl URL has no state location key (${location.reason})`);
  }
  return location.key;
};

const isCrawlUrlState = (value: unknown): value is CrawlUrlState =>
  typeof value === 'string' && (CRAWL_URL_STATES as readonly string[]).includes(value);

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
    if (!isIncompleteReasonDetail(skipReason.detail)) {
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
    stateId: stateIdOfUrl(normalized.url),
  };
  if (options.maxDepth !== undefined && depth > options.maxDepth && !isSkippedByDepthLimit(entry)) {
    throw invalid(`depth ${depth} exceeds the max depth ${options.maxDepth} without ${MAX_DEPTH_REACHED_REASON.code}`);
  }
  return entry;
};

/**
 * Run の BFS の URL の状態、深さ、ページの ID を持つ（Task 14〜17 の設計書 5.6.3）。
 * - FIFO と重複の排除は `CrawlQueue` が受け持つ。状態と深さは、ここが URL ごとに持つ。
 * - ページの ID は、URL を初めて発見したときに、Run の採番器で採番する（発見の順と ID が一致し、決定論的になる）。
 * - 深さが `maxDepth` を超える URL は、キューに入れずに `SKIPPED`（理由 `MAX_DEPTH_REACHED`）にする。
 * - 状態の遷移は、`QUEUED` → `AUDITING` → `AUDITED`・`FAILED` と、まだ終えていない URL の `SKIPPED` と、サイトの不調で捨てた URL
 *   （`detail` のある `SITE_UNAVAILABLE` の `SKIPPED`）を確かめ直す（最大 4 回）ための `SKIPPED` → `AUDITING`（`requeueForRecheck`）だけを
 *   受け付ける。それ以外の遷移は、呼び出し側の誤りとして `Error` を投げる。
 * - 中断した Run の再開のために、記録を `snapshot` で取り出し、`CrawlFrontier.restore` で新しい frontier に作り直せる。
 */
export class CrawlFrontier {
  /** 待ち行列。`CrawlFrontier.restore` が、作り直した待ち行列に置き換えるときだけ代入し直す。 */
  #queue = new CoverageQueue();
  readonly #entries = new Map<string, MutableEntry>();
  /** COV-4: 待ち行列の状態の ID から、URL の記録。 */
  readonly #entriesByStateId = new Map<string, MutableEntry>();
  /** COV-4: `next` で渡し、まだ `completePage` を受けていない状態の ID。 */
  readonly #reading = new Set<string>();
  /** COV-4 の区切り 3: 監査した開いた状態の構造の鍵（受け付けた順）。 */
  readonly #openedStructureKeys = new Set<string>();
  /** COV-4 の区切り 3: 開いた状態の中で押した組（受け付けた順）。 */
  readonly #openedPresses = new Map<string, OpenedPressKey>();
  /** DUP: 同じ作りの 1 回目と、点検を終えた画面の中身の表（ページの ID ごとに 1 件。受け付けた順）。 */
  readonly #pageReferences = new Map<PageId, PageReferenceRecord>();
  /** L14: 深さの上限。`undefined` は上限なし（利用者が指定したときだけ効く）。 */
  readonly #maxDepth: number | undefined;
  readonly #allocator: IdAllocator;

  constructor(maxDepth: number | undefined, allocator: IdAllocator) {
    if (maxDepth !== undefined && !isNonNegativeSafeInteger(maxDepth)) {
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
    for (const entry of entries) {
      frontier.#entriesByStateId.set(entry.stateId, entry);
    }
    // COV-4 の区切り 3（設計者の判断 2026-11-10）: 監査した開いた状態の構造の鍵。前の版の保存（欄がない）は、空の集合として読む。
    const openedKeys: unknown = snapshot.openedStructureKeys ?? [];
    if (!Array.isArray(openedKeys) || !openedKeys.every((key) => typeof key === 'string' && isSha256Fingerprint(key))) {
      throw new RangeError('crawl frontier snapshot has opened structure keys that are not fingerprint digests');
    }
    for (const key of openedKeys as readonly string[]) {
      frontier.#openedStructureKeys.add(key);
    }
    const presses: unknown = snapshot.openedPresses ?? [];
    if (!Array.isArray(presses) || !presses.every(isOpenedPressKey)) {
      throw new RangeError('crawl frontier snapshot has opened presses that are not pressed pairs');
    }
    for (const press of presses as readonly OpenedPressKey[]) {
      frontier.#openedPresses.set(openedPressKeyText(press), Object.freeze({ ...press }));
    }
    // DUP: 同じ作りの 1 回目と、点検を終えた画面の中身の表。前の版の保存（欄がない）は、空として読む。
    const references: unknown = snapshot.pageReferences ?? [];
    if (!Array.isArray(references) || !references.every(isPageReferenceRecord)) {
      throw new RangeError('crawl frontier snapshot has page references that are not page reference records');
    }
    for (const reference of references as readonly PageReferenceRecord[]) {
      frontier.acceptPageReference(reference);
    }
    if (snapshot.coverage !== undefined) {
      // COV-4: 今の版の保存。待ち行列は書き出しから作り直す（取り出して読み終えていない状態は、`next` がもう一度渡す。記録が終えていれば飛ばす）。
      frontier.#queue = CoverageQueue.restore(snapshot.coverage);
      return frontier;
    }
    // COV-4（設計者の判断 2026-11-10）: 前の版の保存（待ち行列の書き出しがない）は、記録から読み替える。終えた記録（AUDITED・FAILED・SKIPPED）は読み終えた
    // 状態にし（その後に同じ URL が辺に出ても、入れない）、QUEUED（監査の途中だった AUDITING と、戻す理由の SKIPPED を含む）を発見の順に入口にする。
    // 深さの上限による SKIPPED は、今までどおり待ち行列に入れない（`discover` と同じ）。
    const queue = new CoverageQueue();
    for (const entry of entries) {
      if (entry.state !== 'QUEUED' && !isSkippedByDepthLimit(entry)) {
        queue.enqueue({ kind: 'LINK', url: entry.url, frame: null, openedRegion: null }, { depth: entry.depth });
      }
    }
    for (let item = queue.next(); item !== undefined; item = queue.next()) {
      queue.completeRead(item.stateId, { structureKey: UNREAD_PAGE_STRUCTURE_KEY, edges: [] });
    }
    for (const entry of entries) {
      if (entry.state === 'QUEUED') {
        queue.enqueue({ kind: 'LINK', url: entry.url, frame: null, openedRegion: null }, { depth: entry.depth });
      }
    }
    frontier.#queue = queue;
    return frontier;
  }

  /** すべての URL の記録（発見の順。`entries` と同じ形）と、COV-4 の待ち行列の書き出し。深く凍結した、JSON にできる値。frontier は変えない。 */
  snapshot(): CrawlFrontierSnapshot {
    return deepFreeze({
      entries: [...this.#entries.values()].map(({ url, depth, pageId, state, skipReason }) => ({
        url,
        depth,
        pageId,
        state,
        skipReason: skipReason === null ? null : { code: skipReason.code, detail: skipReason.detail },
      })),
      coverage: this.#queue.snapshot(),
      openedStructureKeys: [...this.#openedStructureKeys],
      openedPresses: [...this.#openedPresses.values()].map((press) => ({ ...press })),
      pageReferences: [...this.#pageReferences.values()].map((reference) => ({ ...reference })),
    });
  }

  /**
   * DUP: 点検を終えた画面を、同じ作りの表に受け付ける（同じページの ID は、後のもの（読み直し）で、受け付けた順のまま置き換える）。表は `snapshot` に残り、
   * 再開でも引き継ぐ。形の違う値は `RangeError`。
   */
  acceptPageReference(reference: PageReferenceRecord): void {
    if (!isPageReferenceRecord(reference)) {
      throw new RangeError('page reference must have a fingerprint template key, a page ID, a depth and a content digest or null');
    }
    this.#pageReferences.set(reference.pageId, Object.freeze({ ...reference }));
  }

  /** DUP: 作りの鍵の 1 回目（最初に受け付けた `FULL` の画面。なければ `null`）。 */
  pageReferenceOf(templateKey: string): PageId | null {
    for (const reference of this.#pageReferences.values()) {
      if (reference.templateKey === templateKey && reference.depth === 'FULL') {
        return reference.pageId;
      }
    }
    return null;
  }

  /** DUP: 同じ作りで、表示の中身の要約が同じ、点検を終えた画面（最初に受け付けたもの。なければ `null`）。 */
  samePageOf(templateKey: string, contentDigest: string): PageId | null {
    for (const reference of this.#pageReferences.values()) {
      if (reference.templateKey === templateKey && reference.contentDigest === contentDigest) {
        return reference.pageId;
      }
    }
    return null;
  }

  /**
   * COV-4 の区切り 3（入れ子の開いた状態。設計者の判断 2026-11-10）: 開いた状態の中で押す組を受け付ける。Run の全体で初めての組なら記録して真（押す）、見た組
   * なら偽。押した組は `snapshot` に残る（再開の後も押し直さない）。形の違う値は `RangeError`。
   */
  acceptOpenedPress(press: OpenedPressKey): boolean {
    if (!isOpenedPressKey(press)) {
      throw new RangeError('opened press must have a fingerprint structure key, a candidate ID and a non-negative ordinal');
    }
    const text = openedPressKeyText(press);
    if (this.#openedPresses.has(text)) {
      return false;
    }
    this.#openedPresses.set(text, Object.freeze({ structureKey: press.structureKey, candidateId: press.candidateId, ordinal: press.ordinal }));
    return true;
  }

  /**
   * COV-4 の区切り 3（設計者の判断 2026-11-10）: 開いた状態の構造の鍵を受け付ける。Run の全体で初めての鍵なら記録して真（その状態を監査する）、見た鍵なら偽。
   * 見た鍵は `snapshot` に残り、再開の後も同じ状態を 2 回監査しない。digest でない値は `RangeError`。
   */
  acceptOpenedStructure(structureKey: string): boolean {
    if (!isSha256Fingerprint(structureKey)) {
      throw new RangeError('opened structure key must be a fingerprint digest');
    }
    if (this.#openedStructureKeys.has(structureKey)) {
      return false;
    }
    this.#openedStructureKeys.add(structureKey);
    return true;
  }

  /** 発見した URL の数（開始の URL を含む。設計書 5.6.5 の `discoveredPageCount`）。 */
  get discoveredCount(): number {
    return this.#entries.size;
  }

  /**
   * URL を深さ `depth` で発見する。初めての URL なら、ページの ID を採番し、深さが上限以内ならキューに入れる（`QUEUED`）。
   * 上限を超えるなら `SKIPPED`（`MAX_DEPTH_REACHED`）にする。すでに発見していた URL は、何もしない（`KNOWN`）。
   * BFS では、先に発見した深さが最も浅いので、後から浅い深さで発見し直すことはない。
   * OP-I（I2）: `options.preferred` の URL は、待ち行列で印のない URL より先に読む（操作さがしの段だけが渡す。点検の段の Run Coordinator は渡さず、今までどおり
   * BFS の順）。ページの ID・深さの上限・重複の排除は変えない。印のある URL は、深さの浅い印のない URL より先に読むことがある。
   */
  discover(url: NormalizedHttpUrlEvidence, depth: number, options: CrawlEnqueueOptions = {}): CrawlDiscovery {
    if (!isNonNegativeSafeInteger(depth)) {
      throw new RangeError('crawl depth must be a non-negative safe integer');
    }
    if (this.#entries.has(url)) {
      return 'KNOWN';
    }
    const entry = this.#addEntry(url, depth);
    if (entry.state === 'SKIPPED') {
      return 'SKIPPED';
    }
    const result = this.#queue.enqueue({ kind: 'LINK', url, frame: null, openedRegion: null }, { depth, preferred: options.preferred === true });
    if (result.status !== 'QUEUED') {
      throw new Error(`crawl queue rejected a newly discovered URL (${result.status})`);
    }
    entry.state = 'QUEUED';
    return 'QUEUED';
  }

  /**
   * COV-4（網羅の設計書 3.2）: 読んだページの事実（構造の鍵と出た辺）を待ち行列に渡す。待ち行列が、まだ見ていない場所の辺を入れ、終わりのない続きを閉じる。
   * 新しく入った URL の記録（ページの ID は見つけた順に採番。深さは記録だけで、利用者が上限を指定したときだけ、超えた URL を `SKIPPED`）を返す。
   * 監査を終えた（`markFinished`）・飛ばした URL に、1 回だけ呼ぶ。2 回目（確かめ直しの後など）は、辺を見つけた元のない入口として入れる（続きは閉じない）。
   */
  completePage(url: NormalizedHttpUrlEvidence, outcome: CrawlPageOutcome): readonly CrawlUrlEntry[] {
    const entry = this.#entry(url);
    const edges = outcome.edges.filter((edge) => edge.url !== url);
    const queued = new Set<string>();
    if (this.#reading.delete(entry.stateId)) {
      const result = this.#queue.completeRead(entry.stateId, {
        structureKey: outcome.structureKey,
        edges: edges.map((edge) => ({ kind: edge.kind, url: edge.url, frame: null, openedRegion: null })),
      });
      for (const stateId of result.queuedStateIds) {
        queued.add(stateId);
      }
    } else {
      for (const edge of edges) {
        const result = this.#queue.enqueue({ kind: edge.kind, url: edge.url, frame: null, openedRegion: null }, { depth: entry.depth + 1 });
        if (result.status === 'QUEUED') {
          queued.add(result.stateId);
        }
      }
    }
    // 待ち行列に入った（場所の鍵がまだなかった）辺だけに、記録を作る（辺の順。閉じた続きの辺は入らないので、記録も作らない）。
    const added: CrawlUrlEntry[] = [];
    for (const edge of edges) {
      const stateId = stateIdOfUrl(edge.url);
      if (!queued.has(stateId) || this.#entries.has(edge.url)) {
        continue;
      }
      const created = this.#addEntry(edge.url, entry.depth + 1);
      if (created.state !== 'SKIPPED') {
        created.state = 'QUEUED';
      }
      added.push(this.#snapshot(created));
    }
    return added;
  }

  /**
   * 次に監査する URL（待ち行列の順）。なければ `undefined`。状態は変えない（`QUEUED` のまま）。COV-4: 待ち行列から渡された状態のうち、記録がもう終えている
   * もの（深さの上限で飛ばした URL・再開の前に終えた URL）は、読み終えたことにして次へ進む。
   */
  next(): CrawlUrlEntry | undefined {
    for (let item = this.#queue.next(); item !== undefined; item = this.#queue.next()) {
      const entry = this.#entriesByStateId.get(item.stateId);
      if (entry !== undefined && entry.state === 'QUEUED' && !item.rebuild) {
        this.#reading.add(entry.stateId);
        return this.#snapshot(entry);
      }
      this.#queue.completeRead(item.stateId, { structureKey: UNREAD_PAGE_STRUCTURE_KEY, edges: [] });
    }
    return undefined;
  }

  markAuditing(url: NormalizedHttpUrlEvidence): void {
    this.#transition(url, ['QUEUED'], 'AUDITING');
  }

  /**
   * サイトの不調で捨てた URL（理由のコードが `SITE_UNAVAILABLE` で、`detail` のある `SKIPPED`。止まるきっかけのページの印）を、同じ実行の
   * 中で確かめ直す（1 ページにつき最大 4 回。回数は Run Coordinator が数える）ために、`AUDITING` に戻す（理由は `null` にする。サイトが
   * 応答しないときに Run を止める設計書 3.5.2、3.6.2）。
   * 待ち行列は通さない（次に監査するのは、呼び出し側が持っている、その URL の記録である）。`snapshot` と `restore` の形は変えない。
   * ほかの状態と理由（始めなかった URL の、`detail` のない `SITE_UNAVAILABLE` を含む）からは戻さず、呼び出し側の誤りとして `Error` を投げる。
   */
  requeueForRecheck(url: NormalizedHttpUrlEvidence): void {
    const entry = this.#entry(url);
    const reason = entry.skipReason;
    if (entry.state !== 'SKIPPED' || reason?.code !== SITE_UNAVAILABLE_SKIP_REASON.code || reason.detail === null) {
      throw new Error(
        `invalid crawl URL state transition: ${entry.state}${reason === null ? '' : ` (${reason.code})`} -> AUDITING for a recheck`,
      );
    }
    this.#transition(url, ['SKIPPED'], 'AUDITING').skipReason = null;
  }

  /**
   * EV-5: 再開の前に終えた URL（`AUDITED`・`FAILED`）を、読み直すために `AUDITING` に戻す（再開の列の先に置く画面。`src/orchestration/resume-revisit.ts`）。
   * 待ち行列は通さない（次に監査するのは、呼び出し側が持っている、その URL の記録である）。`snapshot` と `restore` の形は変えない。
   */
  reopenForRevisit(url: NormalizedHttpUrlEvidence): void {
    this.#transition(url, ['AUDITED', 'FAILED'], 'AUDITING');
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
    const { url, depth, pageId, state, skipReason } = entry;
    return Object.freeze({ url, depth, pageId, state, skipReason });
  }

  /** 初めての URL の記録を作る（ページの ID を採番する。深さが利用者の上限を超えるなら `SKIPPED`、ほかは `DISCOVERED`）。 */
  #addEntry(url: NormalizedHttpUrlEvidence, depth: number): MutableEntry {
    const entry: MutableEntry = {
      url, depth, pageId: this.#allocator.allocatePageId(), state: 'DISCOVERED', skipReason: null, stateId: stateIdOfUrl(url),
    };
    this.#entries.set(url, entry);
    this.#entriesByStateId.set(entry.stateId, entry);
    if (this.#maxDepth !== undefined && depth > this.#maxDepth) {
      entry.state = 'SKIPPED';
      entry.skipReason = MAX_DEPTH_REACHED_REASON;
    }
    return entry;
  }
}
