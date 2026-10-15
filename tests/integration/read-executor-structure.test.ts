// T27e（Task 27 の設計書 4.5）: READ の結果のページの構造の読み取り（`src/discovery/read-executor.ts` の `readPageStructure`。1 回の
// `page.evaluate`、標準の prototype の getter）を、本物の Chromium（headless だけ）の、ネットワークのないページ（`setContent`）で確かめる。
// - 主な領域: `main` がちょうど 1 つならそれ、なければ（2 つ以上も）`body`。`nav`・`header`・`footer`・`aside` の中の構造は数えない。
// - 表: ほかの表の中の表は数えず、`tbody` の `td` を持つ `tr` を行とする（見出しの行、`thead` の行は数えない）。一覧: ほかの一覧と表の中のものは
//   数えず、子の `li` を数える。詳細: `dl`（と、その中の `div`）の `dt` → 次の最初の `dd`。
// - 見えている文字（空白をまとめる）。上限に達したら `limitReached`。ページが DOM の名前を名前つきの要素や `document` の自分のプロパティで
//   上書きしても（DOM clobbering）、読み方は変わらない。
// サーバは使わない（ページは `setContent` で作る）。
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_READ_DETAIL_ENTRIES, MAX_READ_STRUCTURES, readPageStructure } from '../../src/discovery/read-executor.js';
import type { ReadPageStructure } from '../../src/discovery/read-check-evaluation.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';

const LAUNCHERS = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI launch settings', () => launchCliChromium()],
] as const;
const READ_TIMEOUT_MS = 10_000;

describe.each(LAUNCHERS)('T27e: reading the structure of a READ result page (%s)', (_name, launch) => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await launch();
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser?.close();
  });

  const structureOf = async (html: string): Promise<ReadPageStructure> => {
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`);
    const read = await readPageStructure(page, Date.now() + READ_TIMEOUT_MS);
    if (read.status !== 'READ') {
      throw new Error('the structure was not read');
    }
    return read.structure;
  };

  it('reads tables, lists and details of the only main region, leaving navigation, header, footer and aside out', async () => {
    const structure = await structureOf(`
      <header><ul><li>メニュー</li></ul></header>
      <main>
        <nav><ul><li>a</li><li>b</li></ul><table><tbody><tr><td>x</td></tr></tbody></table></nav>
        <h1>一覧</h1>
        <table>
          <thead><tr><td>見出しの行</td></tr></thead>
          <tbody><tr><th>番号</th></tr><tr><td>1</td><td><table><tbody><tr><td>中の表</td></tr></tbody></table></td></tr><tr><td>2</td></tr></tbody>
        </table>
        <ol><li>一<ul><li>中の一覧</li></ul></li><li>二</li><li>三</li></ol>
        <dl><dt>名前</dt><dd> みかん </dd><div><dt>状態</dt><dt>別名</dt><dd>open</dd><dd>二つ目</dd></div></dl>
        <aside><dl><dt>外</dt><dd>外</dd></dl></aside>
      </main>
      <footer><table><tbody><tr><td>f</td></tr></tbody></table></footer>`);
    expect(structure).toMatchObject({
      region: 'MAIN',
      tableRowCounts: [2],
      listItemCounts: [3],
      detailEntries: [{ term: '名前', value: 'みかん' }, { term: '状態', value: 'open' }, { term: '別名', value: 'open' }],
      limitReached: false,
      settled: true,
    });
    expect(structure.text).toContain('一覧');
    expect(structure.text).not.toContain('メニュー');
  });

  it('uses the body when there is no main or more than one main', async () => {
    expect((await structureOf('<table><tbody><tr><td>1</td></tr></tbody></table>'))).toMatchObject({ region: 'BODY', tableRowCounts: [1] });
    expect((await structureOf('<main><p>a</p></main><main><ul><li>b</li></ul></main>'))).toMatchObject({ region: 'BODY', listItemCounts: [1] });
  });

  it('reads with the standard getters even when the page clobbers the DOM names (named elements, an own property of document)', async () => {
    const structure = await structureOf(`
      <main>
        <table><tbody><tr><td>1</td></tr></tbody></table>
        <dl><dt>名前</dt><dd>本当の値</dd></dl>
        <form name="body"><input name="children"><input name="localName"></form>
        <img name="querySelectorAll">
      </main>
      <script>
        document.querySelectorAll = () => [];
      </script>`);
    expect(structure).toMatchObject({ region: 'MAIN', tableRowCounts: [1], detailEntries: [{ term: '名前', value: '本当の値' }] });
  });

  it('marks the limit when there are too many structures or details', async () => {
    const tables = '<table><tbody><tr><td>1</td></tr></tbody></table>'.repeat(MAX_READ_STRUCTURES + 1);
    expect((await structureOf(`<main>${tables}</main>`)).limitReached).toBe(true);
    const details = `<dl>${'<dt>a</dt><dd>b</dd>'.repeat(MAX_READ_DETAIL_ENTRIES + 1)}</dl>`;
    const structure = await structureOf(`<main>${details}</main>`);
    expect(structure.limitReached).toBe(true);
    expect(structure.detailEntries).toHaveLength(MAX_READ_DETAIL_ENTRIES);
  });
});
