// COV-4（網羅の設計書 `doc/design/2026-11-09-beaksight-coverage-by-state-design.md` 3.2・3.3）の区切り 1 の結合のテスト（既定の Chromium。サーバは 127.0.0.1 だけ）。
// 見るだけの点検の Run の待ち行列を `CoverageQueue` に寄せた結果を、Run Coordinator で実際に監査して確かめる。
// - query の値の違う一覧の画面（ページ送り）は、新しい場所が出る間は全部読む。
// - 日付の「次へ」のような終わりのない続きは、新しい場所か構造が出なくなったら終える（閉じた記録は、単体の `crawl-frontier-coverage.test.ts` で確かめる）。
// - 同じ Origin の iframe の中の文書も、ページとして読む。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditRunResult } from '../../src/core/contracts.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { createRunLauncher, runWithCoordinator } from '../helpers/run-harness.js';
import { createTestConfig } from '../helpers/test-config.js';

const RUN_TEST_TIMEOUT_MS = 300_000;
const LIST_LAST_PAGE = 3;

const html = (title: string, body: string): string => '<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,">'
  + `<title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;

const pageOf = (path: string, query: URLSearchParams): string | null => {
  if (path === '/') {
    return html('入口', '<a href="/list?page=1">一覧</a> <a href="/calendar?day=1">予定</a> <iframe title="枠" src="/frame.html"></iframe>');
  }
  if (path === '/frame.html') {
    return html('枠の中', '<p>枠の中の文書です。</p>');
  }
  if (path === '/list') {
    const page = Number(query.get('page') ?? '1');
    const next = page < LIST_LAST_PAGE ? `<a href="/list?page=${String(page + 1)}">次へ</a>` : '';
    return html('一覧', `<a href="/item/${String(page)}">品物 ${String(page)}</a> ${next}`);
  }
  if (path.startsWith('/item/')) {
    return html('品物', '<p>品物の説明です。</p>');
  }
  if (path === '/calendar') {
    // 終わりのない「次の日」（同じ構造のまま、いつまでも次の日へのリンクがある）。
    const day = Number(query.get('day') ?? '1');
    return html('予定', `<p>${String(day)} 日の予定はありません。</p><a href="/calendar?day=${String(day + 1)}">次の日</a> <a href="/">入口</a>`);
  }
  return null;
};

let server: LoopbackHttpServer | undefined;
const directories: string[] = [];
const runLauncher = createRunLauncher();

afterEach(async () => {
  const leftovers = await runLauncher.closeAll();
  await server?.close();
  server = undefined;
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
  expect(leftovers, 'Browsers left connected after the Run').toBe(0);
});

describe('COV-4: the audit run reads the site by the coverage queue', () => {
  it('reads every list page and the same-origin frame, and ends an endless continuation', async () => {
    server = await startLoopbackHttpServer((request, response) => {
      const parsed = new URL(request.url ?? '/', 'http://127.0.0.1');
      const body = pageOf(parsed.pathname, parsed.searchParams);
      if (body === null) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
    });
    const outputDirectory = await mkdtemp(join(tmpdir(), 'beaksight-cov4-'));
    directories.push(outputDirectory);
    const { origin } = server;
    const result: AuditRunResult = await runWithCoordinator({
      config: createTestConfig(origin, '/', {
        viewports: { stressWidths: [] },
        audit: { interactions: false, performance: false, screenshots: false, accessibility: false },
      }),
      launchBrowser: runLauncher.launcher,
      outputDirectory,
    });

    const audited = result.pages.filter((page) => page.status !== 'SKIPPED').map((page) => page.pageUrl.slice(origin.length)).sort();
    expect(audited).toEqual([
      '/',
      '/calendar?day=1',
      '/calendar?day=2',
      '/frame.html',
      '/item/1',
      '/item/2',
      '/item/3',
      '/list?page=1',
      '/list?page=2',
      '/list?page=3',
    ]);
    expect(result.pages.some((page) => page.pageUrl.endsWith('/calendar?day=3'))).toBe(false);
    expect(result.run.crawlLimits).toEqual({ maxPagesReached: false, maxDepthReached: false, maxRuntimeReached: false });
  }, RUN_TEST_TIMEOUT_MS);
});
