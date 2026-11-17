// MEM-3a（DEF-266。設計書 `2026-11-13-beaksight-run-memory-scaling-design.md` 3 章の MEM-3）: ページの結果の置き場所（`src/core/run-page-store.ts`）。
// 本体は圧縮して持ち、要約だけを生で持つ。取り出しは 1 ページずつ（同時に戻すのは 1 ページだけ）。配列と置き場所は、同じ口でなめられる。
import { describe, expect, it } from 'vitest';
import type { PageAuditResult } from '../../src/core/contracts.js';
import { createPageId } from '../../src/core/ids.js';
import {
  createRunPageStore,
  forEachRunPage,
  runPageCountOf,
  ZLIB_RUN_PAGE_CODEC,
  type RunPageCodec,
} from '../../src/core/run-page-store.js';
import { dom, edgeCaseAuditRun, page, pagesArrayOf as visited, storeOf } from '../helpers/audit-run-fixture.js';

/** 見本のページ（Evidence を持つもの）。 */
const samplePages = (): readonly PageAuditResult[] => edgeCaseAuditRun().pages;

describe('MEM-3a: the run page store keeps the pages compressed and gives them back one at a time', () => {
  it('gives back the added pages as they were, in the added order, with their summaries', async () => {
    const pages = samplePages();
    const store = await storeOf(pages, ({ pageId }) => ({ pageId }));

    expect(runPageCountOf(store)).toBe(pages.length);
    expect(store.summaries()).toEqual(pages.map(({ pageId }) => ({ pageId })));
    const back = await visited(store);
    expect(back).toEqual(pages);
    expect(back.map((value) => JSON.stringify(value))).toEqual(pages.map((value) => JSON.stringify(value)));
    // 配列も、同じ口でなめられる。
    expect(runPageCountOf(pages)).toBe(pages.length);
    expect(await visited(pages)).toEqual(pages);
  });

  it('replaces the body of a page and keeps its summary', async () => {
    const [first, second] = samplePages();
    if (first === undefined || second === undefined) {
      throw new Error('the sample needs two pages');
    }
    const store = createRunPageStore<string>();
    await store.add(first, 'first');
    await store.add(second, 'second');
    const replaced = { ...first, incompleteReasons: [] };
    await store.replace(0, replaced);

    expect(await visited(store)).toEqual([replaced, second]);
    expect(store.summaries()).toEqual(['first', 'second']);
    await expect(store.replace(2, first)).rejects.toThrow(RangeError);
  });

  // MEM-3b: Run の終わりに、終わった順のページを発見の順に並べ直す（本体は圧縮したまま共有し、圧縮し直さない）。開始のページの要約も入れ替えられる。
  it('orders the pages by the given indexes without encoding them again, and replaces a summary with the body', async () => {
    const pages = samplePages();
    let encoded = 0;
    const counting: RunPageCodec = {
      encode: async (value) => {
        encoded += 1;
        return ZLIB_RUN_PAGE_CODEC.encode(value);
      },
      decode: async (bytes) => ZLIB_RUN_PAGE_CODEC.decode(bytes),
    };
    const store = createRunPageStore<number>({ codec: counting });
    for (const [index, value] of pages.entries()) {
      await store.add(value, index);
    }
    const order = pages.map((_unused, index) => pages.length - 1 - index);
    const ordered = store.ordered(order);

    expect(encoded).toBe(pages.length);
    expect(ordered.summaries()).toEqual(order);
    expect(await visited(ordered)).toEqual(order.map((index) => pages[index]));
    expect(() => store.ordered([0, 0])).toThrow(RangeError);
    const [first] = pages;
    if (first === undefined) {
      throw new Error('the sample needs a page');
    }
    await ordered.replace(0, first, 99);
    expect(ordered.summaries()[0]).toBe(99);
  });

  it('decodes one page at a time while visiting the pages', async () => {
    let live = 0;
    let maxLive = 0;
    const counting: RunPageCodec = {
      encode: async (value) => ZLIB_RUN_PAGE_CODEC.encode(value),
      decode: async (bytes) => {
        live += 1;
        maxLive = Math.max(maxLive, live);
        return ZLIB_RUN_PAGE_CODEC.decode(bytes);
      },
    };
    const store = createRunPageStore<null>({ codec: counting });
    for (let index = 0; index < 8; index += 1) {
      const pageId = createPageId(index + 1);
      await store.add(page(pageId, `/p${String(index)}.html`, 'AUDITED', [dom(index + 1, pageId, 'desktop', `本文 ${String(index)}`)]), null);
    }

    await forEachRunPage(store, async () => {
      await Promise.resolve();
      live -= 1;
    });
    expect(maxLive).toBe(1);
  });

  it('keeps the compressed body smaller than the JSON of a page with repeated records', async () => {
    const pageId = createPageId(1);
    const value = page(pageId, '/', 'AUDITED', [dom(1, pageId, 'desktop', '見出しと本文の行です。'.repeat(2_000))]);
    const store = createRunPageStore<null>();
    await store.add(value, null);
    expect(store.storedByteLength()).toBeLessThan(JSON.stringify(value).length / 4);
  });
});
