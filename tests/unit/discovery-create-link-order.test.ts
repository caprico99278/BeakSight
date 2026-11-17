// OP-I（I2。設計書 `doc/design/2026-10-27-beaksight-one-pass-flow-design.md` 4.1.5）: 操作さがしの段の読む順。
// - 登録の画面らしいリンクの判定（`isCreatePageLink`。`src/discovery/classify.ts`）: 手がかりはリンクの文字・`aria-label`・`title`・アドレスの path の語。語の
//   一覧は `DISCOVERY_CREATE_PAGE_LINK_WORDS`（`src/discovery/classification-words.ts` の 1 か所。日本語と英語）。危険な語に当たるリンクは、先に読まない。
// - 読む順の持ち主（`CrawlFrontier`・`CrawlQueue`）の、先に読む印（`preferred`）: 印のある URL は、印のない URL より先に出る（印のある URL どうし・ない URL
//   どうしは、見つけた順）。印を渡さない呼び出し（点検の段の Run Coordinator）は、今までどおりの FIFO。深さの上限・重複の排除は変えない。
import { describe, expect, it } from 'vitest';
import type { LinkEvidence, NormalizedHttpUrlEvidence } from '../../src/core/evidence-types.js';
import { CrawlQueue } from '../../src/crawl/crawl-queue.js';
import { normalizeUrl } from '../../src/crawl/normalize-url.js';
import { DISCOVERY_CREATE_PAGE_LINK_WORDS, DISCOVERY_CREATE_WORDS } from '../../src/discovery/classification-words.js';
import { isCreatePageLink } from '../../src/discovery/classify.js';
import { CrawlFrontier } from '../../src/orchestration/crawl-frontier.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';

const ORIGIN = 'https://example.com';
const NO_QUERY_PARAMETERS: ReadonlySet<string> = new Set();

const url = (path: string): NormalizedHttpUrlEvidence => {
  const normalized = normalizeUrl(`${ORIGIN}${path}`, `${ORIGIN}/`, NO_QUERY_PARAMETERS);
  if (!normalized.ok) {
    throw new Error(`test fixture must be a normalized URL: ${path}`);
  }
  return normalized.url;
};

/** リンクの Evidence の、判定が読む項目だけを持つ値。 */
const linkOf = (path: string, texts: { readonly anchorText?: string; readonly ariaLabel?: string; readonly title?: string } = {}): Pick<
  LinkEvidence,
  'anchorText' | 'ariaLabel' | 'title' | 'normalized'
> => ({
  anchorText: texts.anchorText ?? '',
  ariaLabel: texts.ariaLabel ?? null,
  title: texts.title ?? null,
  normalized: normalizeUrl(path, `${ORIGIN}/`, NO_QUERY_PARAMETERS),
});

describe('OP-I (I2): the words of the create page links', () => {
  it('keeps one frozen list with the create words and the Japanese and English words of the design', () => {
    expect(Object.isFrozen(DISCOVERY_CREATE_PAGE_LINK_WORDS)).toBe(true);
    expect(new Set(DISCOVERY_CREATE_PAGE_LINK_WORDS).size).toBe(DISCOVERY_CREATE_PAGE_LINK_WORDS.length);
    expect(DISCOVERY_CREATE_PAGE_LINK_WORDS).toEqual(expect.arrayContaining([...DISCOVERY_CREATE_WORDS]));
    expect(DISCOVERY_CREATE_PAGE_LINK_WORDS).toEqual(expect.arrayContaining(['登録', '追加', '新規', '作成', '新しく', 'new', 'create', 'add', 'register']));
    for (const word of DISCOVERY_CREATE_PAGE_LINK_WORDS) {
      expect(word.normalize('NFKC').toUpperCase().toLowerCase(), word).toBe(word);
    }
  });

  it('finds a create page link by the text, aria-label, title or the words of the path', () => {
    expect(isCreatePageLink(linkOf('/admin/a', { anchorText: '新規登録' }))).toBe(true);
    expect(isCreatePageLink(linkOf('/admin/b', { ariaLabel: '項目を追加' }))).toBe(true);
    expect(isCreatePageLink(linkOf('/admin/c', { title: '新しく作る' }))).toBe(true);
    expect(isCreatePageLink(linkOf('/admin/orders/new'))).toBe(true);
    expect(isCreatePageLink(linkOf('/admin/items/create?x=1', { anchorText: 'はじめる' }))).toBe(true);
    expect(isCreatePageLink(linkOf('/admin/users/addUser'))).toBe(true);
    expect(isCreatePageLink(linkOf('/admin/register'))).toBe(true);
    expect(isCreatePageLink(linkOf('/admin/%E7%99%BB%E9%8C%B2'))).toBe(true);
    expect(isCreatePageLink(linkOf('/admin/NEW', { anchorText: 'Ｎｅｗ' }))).toBe(true);
  });

  it('does not find a page without the words, a word inside another English word, or a link with a dangerous word', () => {
    expect(isCreatePageLink(linkOf('/admin/list', { anchorText: '一覧' }))).toBe(false);
    expect(isCreatePageLink(linkOf('/admin/address', { anchorText: 'address' }))).toBe(false);
    expect(isCreatePageLink(linkOf('/admin/newsletter', { anchorText: 'renewal' }))).toBe(false);
    // 危険な語（削除・取り消しなど）に当たるリンクは、先に読まない（読むかどうかは、今の除外の判定のまま）。
    expect(isCreatePageLink(linkOf('/admin/a', { anchorText: '登録を取り消す' }))).toBe(false);
    expect(isCreatePageLink(linkOf('/admin/items/new/delete', { anchorText: '新規' }))).toBe(false);
    expect(isCreatePageLink(linkOf('/admin/b', { anchorText: 'add', title: 'remove' }))).toBe(false);
    // 正規化できないリンクも、先に読まない。
    expect(isCreatePageLink(linkOf('javascript:void(0)', { anchorText: '新規登録' }))).toBe(false);
  });
});

describe('OP-I (I2): the read order of the crawl queue and the frontier', () => {
  it('takes the preferred candidates first in the found order, then the others in the found order', () => {
    const queue = new CrawlQueue();
    expect(queue.enqueue({ url: url('/a'), depth: 1 })).toBe(true);
    expect(queue.enqueue({ url: url('/new-1'), depth: 1 }, { preferred: true })).toBe(true);
    expect(queue.enqueue({ url: url('/b'), depth: 1 })).toBe(true);
    expect(queue.enqueue({ url: url('/new-2'), depth: 2 }, { preferred: true })).toBe(true);
    // 重複は、印があっても受け付けない。
    expect(queue.enqueue({ url: url('/a'), depth: 1 }, { preferred: true })).toBe(false);
    expect(queue.dequeue()?.url).toBe(url('/new-1'));
    expect(queue.enqueue({ url: url('/new-3'), depth: 2 }, { preferred: true })).toBe(true);
    expect([queue.dequeue(), queue.dequeue(), queue.dequeue(), queue.dequeue(), queue.dequeue()].map((candidate) => candidate?.url))
      .toEqual([url('/new-2'), url('/new-3'), url('/a'), url('/b'), undefined]);
  });

  it('keeps the FIFO order without the mark (the audit stage)', () => {
    const queue = new CrawlQueue();
    for (const path of ['/a', '/new', '/b']) {
      expect(queue.enqueue({ url: url(path), depth: 1 })).toBe(true);
    }
    expect([queue.dequeue(), queue.dequeue(), queue.dequeue()].map((candidate) => candidate?.url)).toEqual([url('/a'), url('/new'), url('/b')]);
  });

  it('lets the frontier read the preferred URLs first, with the page IDs in the found order and the depth limit unchanged', () => {
    const frontier = new CrawlFrontier(1, new IdAllocator());
    expect(frontier.discover(url('/'), 0)).toBe('QUEUED');
    expect(frontier.next()?.url).toBe(url('/'));
    expect(frontier.discover(url('/a'), 1)).toBe('QUEUED');
    expect(frontier.discover(url('/b'), 1)).toBe('QUEUED');
    expect(frontier.discover(url('/items/new'), 1, { preferred: true })).toBe('QUEUED');
    // 深さの上限を超える URL は、印があっても読まない。
    expect(frontier.discover(url('/deep/new'), 2, { preferred: true })).toBe('SKIPPED');
    const order = [frontier.next(), frontier.next(), frontier.next(), frontier.next()];
    expect(order.map((entry) => entry?.url)).toEqual([url('/items/new'), url('/a'), url('/b'), undefined]);
    // ページの ID は、見つけた順のまま。
    expect(frontier.entries().map((entry) => entry.url)).toEqual([url('/'), url('/a'), url('/b'), url('/items/new'), url('/deep/new')]);
  });
});
