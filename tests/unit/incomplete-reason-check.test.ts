// CCX-1（共通化の台帳の CC-034）: 未完了の理由（`IncompleteReason`）の確かめ。
// - 共通化の前後で、2 か所（`skippedPageResult` と、保存からの `CrawlFrontier.restore` の SKIPPED の理由）の判定の結果
//   （受ける値と拒む値。拒むときの例外の型と文）が変わらないことを固定する。
// - 確かめの関数の owner（`src/core/contracts.ts`。理由の閉じた一覧の owner）の関数を確かめる。
import { describe, expect, it } from 'vitest';
import {
  INCOMPLETE_REASON_CODES,
  isIncompleteReason,
  isIncompleteReasonCode,
  isIncompleteReasonDetail,
  type IncompleteReason,
  type PageId,
} from '../../src/core/contracts.js';
import type { NormalizedHttpUrlEvidence } from '../../src/core/evidence-types.js';
import { createPageId } from '../../src/core/ids.js';
import { CrawlFrontier, type StoredCrawlUrlEntry } from '../../src/orchestration/crawl-frontier.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';
import { skippedPageResult } from '../../src/orchestration/skipped-page.js';

const ORIGIN = 'https://example.com';
const SKIPPED_URL = `${ORIGIN}/skipped` as NormalizedHttpUrlEvidence;
const PAGE_ID: PageId = createPageId(1);
const DETAIL = 'desktop:passive';
const UNKNOWN_CODE = 'NOT_A_REASON_CODE';

/** 受ける理由（すべてのコードと、`detail` の `null` と文字列）。 */
const ACCEPTED_REASONS: readonly IncompleteReason[] = INCOMPLETE_REASON_CODES.flatMap((code) => [
  { code, detail: null },
  { code, detail: DETAIL },
]);

/** 拒む理由のうち、コードが不正なもの。 */
const INVALID_CODE_REASONS: readonly (readonly [string, unknown])[] = [
  ['an unknown code', { code: UNKNOWN_CODE, detail: null }],
  ['a code in lower case', { code: INCOMPLETE_REASON_CODES[0].toLowerCase(), detail: null }],
  ['a number code', { code: 1, detail: null }],
  ['a null code', { code: null, detail: null }],
  ['no code', { detail: null }],
];

/** 拒む理由のうち、コードは正しく、`detail` が不正なもの（`detail` がないものを含む）。 */
const INVALID_DETAIL_REASONS: readonly (readonly [string, unknown])[] = [
  ['a number detail', { code: INCOMPLETE_REASON_CODES[0], detail: 1 }],
  ['an object detail', { code: INCOMPLETE_REASON_CODES[0], detail: {} }],
  ['an undefined detail', { code: INCOMPLETE_REASON_CODES[0], detail: undefined }],
  ['no detail', { code: INCOMPLETE_REASON_CODES[0] }],
];

/** 拒む値のうち、オブジェクトでないもの（配列を含む）。 */
const NON_RECORD_REASONS: readonly (readonly [string, unknown])[] = [
  ['null', null],
  ['undefined', undefined],
  ['a string', INCOMPLETE_REASON_CODES[0]],
  ['an array', [INCOMPLETE_REASON_CODES[0], null]],
];

const SKIPPED_PAGE_REASON_ERROR = 'skipped page reason must be an incomplete reason with a known code and a detail';

describe('skippedPageResult keeps accepting and rejecting the same reasons (CCX-1 pinning)', () => {
  it.each(ACCEPTED_REASONS)('accepts the reason %o', (reason) => {
    expect(skippedPageResult(SKIPPED_URL, PAGE_ID, reason).incompleteReasons).toEqual([reason]);
  });

  it.each([...INVALID_CODE_REASONS, ...INVALID_DETAIL_REASONS, ...NON_RECORD_REASONS])('rejects %s', (_name, reason) => {
    expect(() => skippedPageResult(SKIPPED_URL, PAGE_ID, reason as IncompleteReason)).toThrow(new TypeError(SKIPPED_PAGE_REASON_ERROR));
  });

  it('rejects a reason whose detail is only inherited, and an array with the reason properties', () => {
    const inherited = Object.assign(Object.create({ detail: null }) as object, { code: INCOMPLETE_REASON_CODES[0] });
    const array = Object.assign([], { code: INCOMPLETE_REASON_CODES[0], detail: null });

    expect(() => skippedPageResult(SKIPPED_URL, PAGE_ID, inherited as IncompleteReason)).toThrow(new TypeError(SKIPPED_PAGE_REASON_ERROR));
    expect(() => skippedPageResult(SKIPPED_URL, PAGE_ID, array as unknown as IncompleteReason))
      .toThrow(new TypeError(SKIPPED_PAGE_REASON_ERROR));
  });
});

describe('CrawlFrontier.restore keeps accepting and rejecting the same SKIPPED reasons (CCX-1 pinning)', () => {
  const restoreSkipped = (skipReason: unknown): CrawlFrontier =>
    CrawlFrontier.restore(
      {
        entries: [
          { url: `${ORIGIN}/`, depth: 0, pageId: createPageId(1), state: 'AUDITED', skipReason: null },
          { url: SKIPPED_URL, depth: 1, pageId: createPageId(2), state: 'SKIPPED', skipReason: skipReason as StoredCrawlUrlEntry['skipReason'] },
        ],
      },
      { maxDepth: 1, allocator: new IdAllocator(), allowedQueryParameters: new Set(), requeueSkipReasonCodes: new Set() },
    );
  const entryError = (problem: string): RangeError => new RangeError(`crawl frontier snapshot entry 1: ${problem}`);

  it.each(ACCEPTED_REASONS)('accepts the reason %o', (reason) => {
    expect(restoreSkipped(reason).entries()[1]?.skipReason).toEqual(reason);
  });

  it.each(INVALID_CODE_REASONS)('rejects %s as an unsupported code', (_name, reason) => {
    const code = (reason as { readonly code?: unknown }).code;
    expect(() => restoreSkipped(reason)).toThrow(entryError(`unsupported skip reason code: ${String(code)}`));
  });

  it.each(INVALID_DETAIL_REASONS)('rejects %s as an invalid detail', (_name, reason) => {
    expect(() => restoreSkipped(reason)).toThrow(entryError('skip reason detail must be a string or null'));
  });

  it.each([['null', null], ['undefined', undefined], ['a string', INCOMPLETE_REASON_CODES[0]]] as const)(
    'rejects %s as a missing skip reason',
    (_name, reason) => {
      expect(() => restoreSkipped(reason)).toThrow(entryError('SKIPPED needs a skip reason'));
    },
  );

  it('rejects an array as an unsupported code', () => {
    expect(() => restoreSkipped([INCOMPLETE_REASON_CODES[0], null])).toThrow(entryError('unsupported skip reason code: undefined'));
  });
});

describe('the incomplete reason checks of the owner (src/core/contracts.ts, CC-034)', () => {
  it('accepts every code of INCOMPLETE_REASON_CODES as a code, and nothing else', () => {
    for (const code of INCOMPLETE_REASON_CODES) {
      expect(isIncompleteReasonCode(code)).toBe(true);
    }
    for (const [, reason] of INVALID_CODE_REASONS) {
      expect(isIncompleteReasonCode((reason as { readonly code?: unknown }).code)).toBe(false);
    }
  });

  it('accepts a string or null as a detail, and nothing else', () => {
    expect(isIncompleteReasonDetail(null)).toBe(true);
    expect(isIncompleteReasonDetail('')).toBe(true);
    expect(isIncompleteReasonDetail(DETAIL)).toBe(true);
    for (const [, reason] of INVALID_DETAIL_REASONS) {
      expect(isIncompleteReasonDetail((reason as { readonly detail?: unknown }).detail)).toBe(false);
    }
  });

  it('accepts a record with a known code and its own detail as a reason, and nothing else', () => {
    for (const reason of ACCEPTED_REASONS) {
      expect(isIncompleteReason(reason)).toBe(true);
    }
    for (const [, reason] of [...INVALID_CODE_REASONS, ...INVALID_DETAIL_REASONS, ...NON_RECORD_REASONS]) {
      expect(isIncompleteReason(reason)).toBe(false);
    }
    expect(isIncompleteReason(Object.assign(Object.create({ detail: null }) as object, { code: INCOMPLETE_REASON_CODES[0] }))).toBe(false);
    expect(isIncompleteReason(Object.assign([], { code: INCOMPLETE_REASON_CODES[0], detail: null }))).toBe(false);
  });
});
