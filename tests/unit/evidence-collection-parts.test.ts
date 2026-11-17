// COV-6（設計書 `2026-11-09-beaksight-coverage-by-state-design.md` 3.3 の「Evidence・リンク…の件数の上限」）: 件数の上限で打ち切らずに、ページの中の読み取りを
// 件数ごとに分けて集め、同じ記録に全部入れることを、偽のページ（`page.evaluate` が、渡された続きの位置の部分を返す）で確かめる。ブラウザを使わない。
// ページの中の読み取り（続きの位置から返すこと）そのものは、本物のページの結合テスト（`tests/component/*-collector.test.ts`）で確かめる。
import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import type {
  FormDomEvidence,
  HeadingEvidence,
  ImageDomEvidence,
  SemanticRegionEvidence,
} from '../../src/core/evidence-types.js';
import { createPageId } from '../../src/core/ids.js';
import { readInParts } from '../../src/core/read-in-parts.js';
import { LINK_COLLECTION_PART_SIZE, discoverLinks, type LinkDiscoveryPolicy } from '../../src/crawl/discover-links.js';
import {
  DOM_COLLECTION_PART_SIZE,
  DOM_TEXT_PART_LENGTH,
  collectDomEvidence,
  type DomPartCursor,
} from '../../src/evidence/dom-collector.js';

/**
 * `page.evaluate` の 2 つ目の引数を `respond` に渡し、その値を返す偽のページ（渡された引数を記録する）。frame の木は、main frame だけ（COV-4: リンクの記録は、
 * 子の frame の URL を Playwright の frame の木から読む）。
 */
const fakePage = <A>(respond: (argument: A) => unknown): { readonly page: Page; readonly calls: A[] } => {
  const calls: A[] = [];
  const mainFrame = { url: () => 'https://example.test/' };
  const page = {
    evaluate: async (_fn: unknown, argument: A) => {
      calls.push(argument);
      return respond(argument);
    },
    mainFrame: () => mainFrame,
    frames: () => [mainFrame],
  } as unknown as Page;
  return { page, calls };
};

describe('readInParts', () => {
  it('次の位置がなくなるまで読み、部分を読んだ順に返す', async () => {
    const seen: number[] = [];
    const parts = await readInParts(0, async (cursor: number) => {
      seen.push(cursor);
      return { part: `p${cursor}`, next: cursor < 2 ? cursor + 1 : null };
    });
    expect(parts).toEqual(['p0', 'p1', 'p2']);
    expect(seen).toEqual([0, 1, 2]);
  });
});

describe('discoverLinks（分けて集める）', () => {
  const policy: LinkDiscoveryPolicy = { allowedOrigins: new Set(['https://example.test']), allowedQueryParameters: new Set() };

  it('今までの上限を超える件数のリンクを、部分ごとに読んで全部記録する（記録しなかった件数は 0）', async () => {
    const total = LINK_COLLECTION_PART_SIZE * 2 + 3;
    const { page, calls } = fakePage<{ readonly offset: number; readonly partSize: number }>(({ offset, partSize }) => ({
      totalCount: total,
      anchors: Array.from({ length: Math.max(0, Math.min(partSize, total - offset)) }, (_value, index) => ({
        anchorText: `Item ${offset + index}`,
        ariaLabel: null,
        title: null,
        rawHref: `/item-${offset + index}`,
        baseUrl: 'https://example.test/',
      })),
    }));

    const evidence = await discoverLinks(page, createPageId(1), policy);

    expect(calls.map(({ offset }) => offset)).toEqual([0, LINK_COLLECTION_PART_SIZE, LINK_COLLECTION_PART_SIZE * 2]);
    expect(evidence.links).toHaveLength(total);
    expect(evidence.links.at(-1)).toMatchObject({ rawHref: `/item-${total - 1}` });
    expect(evidence.omittedLinkCount).toBe(0);
    expect(evidence.collectedInParts).toBe(3);
  });

  it('上限以内なら 1 回で読む', async () => {
    const { page, calls } = fakePage(() => ({ totalCount: 1, anchors: [{ anchorText: 'One', ariaLabel: null, title: null, rawHref: '/one', baseUrl: 'https://example.test/' }] }));
    const evidence = await discoverLinks(page, createPageId(2), policy);
    expect(calls).toHaveLength(1);
    expect(evidence).toMatchObject({ omittedLinkCount: 0, collectedInParts: 1 });
  });
});

/** 偽のページの DOM の事実（全体）。偽のページが、続きの位置の部分を切り出して返す。 */
const domFacts = (() => {
  const headings: HeadingEvidence[] = Array.from({ length: DOM_COLLECTION_PART_SIZE * 2 + 1 }, (_value, index) => ({ level: 2, text: `H${index}`, truncated: false }));
  const images: ImageDomEvidence[] = Array.from({ length: DOM_COLLECTION_PART_SIZE + 7 }, (_value, index) => ({
    src: `/i${index}.png`, resolvedUrl: `https://example.test/i${index}.png`, alt: null, complete: true, naturalWidth: 1, naturalHeight: 1, truncated: false,
  }));
  const field = (index: number) => ({
    type: 'text', name: `f${index}`, required: false, visible: true, labels: [], hasAriaLabel: false, hasAriaLabelledby: false, hasTitle: false, truncated: false,
  });
  const forms: FormDomEvidence[] = Array.from({ length: 3 }, (_value, index) => ({
    method: 'get',
    action: `/f${index}`,
    // 1 つの form の欄は、今までの上限 200 を超える。
    fields: Array.from({ length: 250 }, (_v, fieldIndex) => field(fieldIndex)),
    submitControls: [],
    omittedFieldCount: 0,
    omittedSubmitControlCount: 0,
    truncated: false,
  }));
  const unassociatedFields = Array.from({ length: 260 }, (_value, index) => field(index));
  const duplicateIds = Array.from({ length: 120 }, (_value, index) => ({ id: `dup-${index}`, count: 2, truncated: false }));
  const regions: SemanticRegionEvidence[] = Array.from({ length: 130 }, (_value, index) => ({ kind: 'main', text: `R${index}`, ariaHidden: false, truncated: false }));
  const text = 'a'.repeat(DOM_TEXT_PART_LENGTH * 2 + 5);
  const ariaHiddenText = 'b'.repeat(10);
  return { headings, images, forms, unassociatedFields, duplicateIds, regions, text, ariaHiddenText };
})();

describe('collectDomEvidence（分けて集める）', () => {
  it('見出し・画像・form・欄・重複の id・区分・可視テキストを、部分ごとに読んで全部記録する', async () => {
    const list = <T>(items: readonly T[], offset: number) => ({ items: items.slice(offset, offset + DOM_COLLECTION_PART_SIZE), total: items.length });
    const text = (value: string, offset: number) => ({ slice: value.slice(offset, offset + DOM_TEXT_PART_LENGTH), total: value.length });
    const { page, calls } = fakePage<{ readonly cursor: DomPartCursor }>(({ cursor }) => ({
      scrollPosition: { scrollX: 0, scrollY: 0 },
      loadingIndicators: { ariaBusyCount: 0, progressbarCount: 0, indeterminateProgressCount: 0 },
      title: 'Title',
      metaDescription: null,
      canonicalUrl: null,
      lang: 'ja',
      documentFields: { title: false, metaDescription: false, canonicalUrl: false, lang: false },
      source: 'SEMANTIC_LANDMARKS',
      headings: list(domFacts.headings, cursor.headings),
      images: list(domFacts.images, cursor.images),
      forms: list(domFacts.forms, cursor.forms),
      unassociatedFields: list(domFacts.unassociatedFields, cursor.unassociatedFields),
      duplicateIds: list(domFacts.duplicateIds, cursor.duplicateIds),
      regions: list(domFacts.regions, cursor.regions),
      text: text(domFacts.text, cursor.text),
      ariaHiddenText: text(domFacts.ariaHiddenText, cursor.ariaHiddenText),
    }));

    const evidence = await collectDomEvidence(page, createPageId(3));

    // DOM の部分の読み取りが 3 回と、AUD-7 の画面の誤りの表示の手がかりの読み取りが 1 回（続きの位置を渡さない）。
    expect(calls.filter((call) => call.cursor !== undefined)).toHaveLength(3);
    expect(calls).toHaveLength(4);
    expect(evidence.headings).toEqual(domFacts.headings);
    expect(evidence.images).toEqual(domFacts.images);
    expect(evidence.forms).toEqual(domFacts.forms);
    expect(evidence.forms[0]?.fields).toHaveLength(250);
    expect(evidence.unassociatedFields).toEqual(domFacts.unassociatedFields);
    expect(evidence.duplicateIds).toEqual(domFacts.duplicateIds);
    expect(evidence.visibleText.regions).toEqual(domFacts.regions);
    expect(evidence.visibleText.text).toBe(domFacts.text);
    expect(evidence.visibleText.ariaHiddenText).toBe(domFacts.ariaHiddenText);
    expect(evidence.visibleText).toMatchObject({ source: 'SEMANTIC_LANDMARKS', truncated: false, nodeLimitReached: false, omittedRegionCount: 0 });
    expect(evidence.truncation).toMatchObject({
      omittedHeadingCount: 0,
      omittedImageCount: 0,
      omittedFormCount: 0,
      omittedUnassociatedFieldCount: 0,
      omittedDuplicateIdCount: 0,
    });
    expect(evidence.collectedInParts).toBe(3);
  });
});
